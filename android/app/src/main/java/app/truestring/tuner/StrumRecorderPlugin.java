package app.truestring.tuner;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * StrumRecorder — SPEC v2.1, "Native capture plugin (the real fix)".
 *
 * <p>Android's WebView asks the OS for a communications input preset, and the HAL then puts noise
 * suppression, automatic gain and sometimes echo cancellation in front of everything
 * {@code getUserMedia} hands back. Web constraints cannot reach that layer. The monophonic tuner
 * survives it; the strum analyser does not, because to a noise suppressor a ringing chord IS
 * stationary noise and the partials it measures are exactly what gets pulled down.
 *
 * <p>So in the APK the strum mode does not use the WebView's microphone at all. This plugin opens
 * {@link AudioRecord} directly on the least-processed input the device admits to having —
 * {@code UNPROCESSED} where {@link AudioManager#PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED} says so,
 * then {@code VOICE_RECOGNITION}, {@code CAMCORDER}, {@code MIC} — and streams raw little-endian
 * PCM16 to the WebView in ~250 ms chunks. The JS side (src/audio/nativecapture.ts) decodes those
 * chunks and feeds them through the SAME onset detector, ring buffer and analyser the web path
 * uses, so nothing about the reading changes except the audio it is a reading of.
 *
 * <p>Which source was actually opened is reported on every chunk and on {@code start()}: a device
 * that has no unprocessed path is still worth recording from, but the app should never have to
 * guess what it got.
 *
 * <p>No WAV framing, no files, no buffering beyond the chunk in flight. The audio never leaves the
 * process except across the bridge into the page that asked for it.
 */
@CapacitorPlugin(
    name = "StrumRecorder",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = StrumRecorderPlugin.MIC_ALIAS)
    }
)
public class StrumRecorderPlugin extends Plugin {

    /** The alias the permission annotation above and every request below agree on. */
    static final String MIC_ALIAS = "microphone";

    private static final String EVENT_CHUNK = "chunk";

    /** What the analyser was measured at, and what every modern phone runs its mics at. */
    private static final int DEFAULT_SAMPLE_RATE = 48000;
    /**
     * Fallbacks, in descending order of usefulness. The strum estimator's own band stops at
     * 3.4 kHz, so even 16 kHz leaves it everything it reads — but a lower rate costs resolution in
     * the period search, so it is a last resort rather than a choice.
     */
    private static final int[] FALLBACK_RATES = { 48000, 44100, 32000, 22050, 16000 };

    /**
     * Chunk length. Short enough that the onset detector's 5 ms hops arrive promptly (the view
     * acknowledges a strum ~0.26 s after the strings are hit, and a chunk longer than that would
     * be the thing that made it late); long enough that the bridge carries four messages a second
     * rather than forty. 250 ms of 48 kHz mono PCM16 is 24 kB raw, 32 kB base64.
     */
    private static final int CHUNK_MS = 250;

    /** Bytes per frame: mono, 16-bit. */
    private static final int BYTES_PER_FRAME = 2;

    /** How long a stop() waits for the reader to come out of its blocking read. */
    private static final long READER_JOIN_MS = 800;

    /** Guards {@link #record} and {@link #reader}. Plugin methods run on Capacitor's own task
        thread, {@link #handleOnDestroy()} runs on the main thread, and the reader runs on neither. */
    private final Object lock = new Object();

    private AudioRecord record;
    private Thread reader;

    /** Read by the reader thread on every pass; written by whoever stops the session. */
    private volatile boolean capturing;

    /** Chunks are posted from here so that the bridge's own postMessage runs where the WebView
        lives. Capacitor resolves calls off the main thread routinely, but this costs four posts a
        second and takes the question off the table. */
    private Handler main;

    @Override
    public void load() {
        main = new Handler(Looper.getMainLooper());
    }

    /* ------------------------------------------------------------------ API */

    /**
     * Begin a capture session. Resolves with the rate and source that were actually opened —
     * neither is a request that can be assumed to have been honoured.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState(MIC_ALIAS) != PermissionState.GRANTED) {
            requestPermissionForAlias(MIC_ALIAS, call, "micPermissionCallback");
            return;
        }
        open(call);
    }

    /** End it. Safe when nothing is running, and safe to call twice. */
    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (lock) {
            closeLocked();
        }
        call.resolve();
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState(MIC_ALIAS) == PermissionState.GRANTED) {
            open(call);
            return;
        }
        // The page turns this code into the same "microphone blocked" card the web path shows.
        call.reject("Microphone permission was not granted", "denied");
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            closeLocked();
        }
    }

    /* -------------------------------------------------------------- capture */

    private void open(PluginCall call) {
        Integer requested = call.getInt("sampleRate");
        int wanted = requested == null ? DEFAULT_SAMPLE_RATE : requested.intValue();

        int rate;
        String openedName;
        synchronized (lock) {
            closeLocked();

            // Checked again here, in the method that opens the device: the grant can be revoked
            // between Capacitor's answer and this line, and a SecurityException from the
            // constructor is a crash rather than a rejection.
            if (getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                call.reject("Microphone permission was not granted", "denied");
                return;
            }

            AudioRecord opened = null;
            int openedSource = MediaRecorder.AudioSource.MIC;
            for (int source : sourceOrder()) {
                for (int candidateRate : rateOrder(wanted)) {
                    AudioRecord candidate = tryOpen(source, candidateRate);
                    if (candidate != null) {
                        opened = candidate;
                        openedSource = source;
                        break;
                    }
                }
                if (opened != null) {
                    break;
                }
            }
            if (opened == null) {
                call.reject("No audio input could be opened", "unavailable");
                return;
            }

            try {
                opened.startRecording();
            } catch (IllegalStateException ex) {
                opened.release();
                call.reject("The microphone could not be started", "unavailable", ex);
                return;
            }
            if (opened.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                opened.release();
                call.reject("The microphone could not be started", "unavailable");
                return;
            }

            rate = opened.getSampleRate();
            openedName = sourceName(openedSource);
            final AudioRecord running = opened;
            final int runningRate = rate;
            final String runningSource = openedName;
            final int bytesPerChunk = chunkBytes(rate);

            record = opened;
            capturing = true;
            reader = new Thread(
                () -> pump(running, runningRate, runningSource, bytesPerChunk),
                "truestring-strum-reader"
            );
            reader.start();
        }

        JSObject ret = new JSObject();
        ret.put("sampleRate", rate);
        ret.put("source", openedName);
        call.resolve(ret);
    }

    /** Reader thread: block on the device, hand up whole chunks, exit the moment it is stopped. */
    private void pump(AudioRecord running, int rate, String source, int chunkSize) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        byte[] buffer = new byte[chunkSize];
        int filled = 0;
        while (capturing) {
            int read = running.read(buffer, filled, chunkSize - filled);
            if (read < 0) {
                // ERROR_INVALID_OPERATION is what a stopped device returns, and stopping is the
                // ordinary way out of this loop. Anything else is a real failure, and there is
                // nothing useful to do about it here either: the session ends.
                if (capturing) {
                    Logger.warn("StrumRecorder: read failed (" + read + "), ending capture");
                }
                return;
            }
            if (read == 0) {
                continue;
            }
            filled += read;
            if (filled < chunkSize) {
                continue;
            }
            emit(buffer, filled, rate, source);
            filled = 0;
        }
    }

    /** One chunk, base64 on this thread and delivered on the main one. */
    private void emit(byte[] buffer, int length, int rate, String source) {
        final JSObject data = new JSObject();
        data.put("base64", Base64.encodeToString(buffer, 0, length, Base64.NO_WRAP));
        data.put("sampleRate", rate);
        data.put("source", source);
        Handler handler = main;
        if (handler == null) {
            notifyListeners(EVENT_CHUNK, data);
            return;
        }
        handler.post(() -> notifyListeners(EVENT_CHUNK, data));
    }

    /**
     * Tear the session down. Callers hold {@link #lock}.
     *
     * <p>Order matters: clearing the flag and stopping the device is what releases the reader from
     * its blocking read, and the device is only released once the reader has actually gone. A
     * reader still inside {@code read()} when {@code release()} lands is a native crash, so a
     * thread that will not join is leaked instead — one dead thread beats a dead app.
     */
    private void closeLocked() {
        capturing = false;
        AudioRecord open = record;
        Thread thread = reader;
        record = null;
        reader = null;

        if (open != null) {
            try {
                if (open.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    open.stop();
                }
            } catch (IllegalStateException ex) {
                Logger.warn("StrumRecorder: stop() refused - " + ex.getMessage());
            }
        }

        boolean gone = true;
        if (thread != null && thread != Thread.currentThread()) {
            try {
                thread.join(READER_JOIN_MS);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            gone = !thread.isAlive();
        }

        if (open != null) {
            if (gone) {
                open.release();
            } else {
                Logger.warn("StrumRecorder: reader did not stop; leaking the AudioRecord");
            }
        }
    }

    /* --------------------------------------------------------------- device */

    /**
     * Sources worth trying, least-processed first.
     *
     * <p>UNPROCESSED is only offered when the device says it has one: asking for it where it is
     * unsupported gets silently substituted, and a substitution the app cannot see is exactly the
     * lie this whole plugin exists to stop telling. VOICE_RECOGNITION is next because it is
     * defined as "no AGC, no NS" even where it is not literally unprocessed; CAMCORDER is a
     * wide-band, un-gated path on most devices; MIC is the last resort and is the one the WebView
     * would have given us anyway.
     */
    private int[] sourceOrder() {
        if (unprocessedSupported()) {
            return new int[] {
                MediaRecorder.AudioSource.UNPROCESSED,
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.MIC
            };
        }
        return new int[] {
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.CAMCORDER,
            MediaRecorder.AudioSource.MIC
        };
    }

    private boolean unprocessedSupported() {
        try {
            Object service = getContext().getSystemService(Context.AUDIO_SERVICE);
            if (!(service instanceof AudioManager)) {
                return false;
            }
            String value = ((AudioManager) service).getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED);
            return "true".equalsIgnoreCase(value);
        } catch (Exception ex) {
            // An OEM AudioManager that throws on an unknown property is not a reason to fail.
            Logger.warn("StrumRecorder: unprocessed-support query failed - " + ex.getMessage());
            return false;
        }
    }

    /** The asked-for rate first, then the standard ladder, with no repeats. */
    private int[] rateOrder(int wanted) {
        int[] order = new int[FALLBACK_RATES.length + 1];
        int n = 0;
        if (wanted > 0) {
            order[n++] = wanted;
        }
        for (int rate : FALLBACK_RATES) {
            if (rate == wanted) {
                continue;
            }
            order[n++] = rate;
        }
        if (n == order.length) {
            return order;
        }
        int[] trimmed = new int[n];
        System.arraycopy(order, 0, trimmed, 0, n);
        return trimmed;
    }

    private AudioRecord tryOpen(int source, int rate) {
        // Repeated from open() deliberately: the constructor below is the call that needs the
        // grant, and a check in the method that makes it is the one both the runtime and Android
        // Lint's MissingPermission detector can see.
        if (getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return null;
        }
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) {
            // ERROR (-1) and ERROR_BAD_VALUE (-2) both land here: the rate is not supported.
            return null;
        }
        // Four chunks of headroom. The reader is never more than one chunk behind, but the WebView
        // can stall the process for a frame or two and an overrun is silence in the middle of a
        // strum — the one failure the analyser cannot see coming.
        int size = Math.max(min * 4, chunkBytes(rate) * 4);

        AudioRecord candidate;
        try {
            candidate = new AudioRecord(
                source,
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                size
            );
        } catch (IllegalArgumentException | UnsupportedOperationException ex) {
            return null;
        } catch (SecurityException ex) {
            Logger.warn("StrumRecorder: refused source " + source + " - " + ex.getMessage());
            return null;
        }
        if (candidate.getState() != AudioRecord.STATE_INITIALIZED) {
            candidate.release();
            return null;
        }
        return candidate;
    }

    private static int chunkBytes(int rate) {
        int frames = Math.max(1, (rate * CHUNK_MS) / 1000);
        return frames * BYTES_PER_FRAME;
    }

    private static String sourceName(int source) {
        if (source == MediaRecorder.AudioSource.UNPROCESSED) {
            return "unprocessed";
        }
        if (source == MediaRecorder.AudioSource.VOICE_RECOGNITION) {
            return "voice_recognition";
        }
        if (source == MediaRecorder.AudioSource.CAMCORDER) {
            return "camcorder";
        }
        return "mic";
    }
}
