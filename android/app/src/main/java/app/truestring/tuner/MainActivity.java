package app.truestring.tuner;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The strum mode's native capture path (SPEC v2.1). Registered BEFORE super.onCreate(),
     * because BridgeActivity builds the bridge at the end of its own onCreate() and a plugin
     * added after that never reaches the WebView.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(StrumRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
