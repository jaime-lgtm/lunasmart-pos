package com.suenodeluna.lunadisplay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reinicia el servicio solo despues de que la tablet arranca, para no
    depender de que alguien abra la app a mano cada vez que hay un reinicio. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            context.startForegroundService(new Intent(context, DisplayService.class));
        }
    }
}
