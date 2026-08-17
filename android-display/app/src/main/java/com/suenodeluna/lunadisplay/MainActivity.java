package com.suenodeluna.lunadisplay;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.TextView;

/** Se abre una sola vez para arrancar el servicio -- la pantalla de cliente
    de verdad vive en DisplayService/SecondScreenPresentation, no aqui, para
    que sobreviva aunque esta ventana se cierre. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView tv = new TextView(this);
        tv.setText("Pantalla de cliente activada.\n\nPuedes cerrar esta ventana -- la pantalla secundaria sigue funcionando por separado.");
        tv.setTextSize(20);
        tv.setPadding(60, 200, 60, 60);
        setContentView(tv);

        startForegroundService(new Intent(this, DisplayService.class));

        tv.postDelayed(this::finish, 3000);
    }
}
