package com.suenodeluna.lunadisplay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.IBinder;
import android.view.Display;

/** Foreground service (no una Activity) para que la Presentation en la
    segunda pantalla siga viva aunque no haya ninguna ventana de esta app
    al frente en la pantalla principal. La conexion a la pantalla se rehace
    en onStartCommand (no solo en onCreate) para que CADA relanzamiento --
    desde el icono de Android o desde el boton "Doble pantalla" del POS --
    tire la Presentation vieja y cargue una WebView nueva, sin caches
    obsoletos ni contenido pegado de una version anterior. */
public class DisplayService extends Service {
    private static final String CHANNEL_ID = "luna_display_channel";
    private SecondScreenPresentation presentation;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, buildNotification());
        attachToSecondScreen();
        return START_STICKY;
    }

    private void attachToSecondScreen() {
        if (presentation != null) { presentation.dismiss(); presentation = null; }
        DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
        Display[] presentationDisplays = dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        Display target = null;
        if (presentationDisplays != null && presentationDisplays.length > 0) {
            target = presentationDisplays[0];
        } else {
            for (Display d : dm.getDisplays()) {
                if (d.getDisplayId() != Display.DEFAULT_DISPLAY) { target = d; break; }
            }
        }
        if (target != null) {
            presentation = new SecondScreenPresentation(this, target);
            presentation.show();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Pantalla de cliente", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("LunaSmart -- Pantalla de cliente")
                .setContentText("Activa en la segunda pantalla")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .build();
    }

    @Override
    public void onDestroy() {
        if (presentation != null) { presentation.dismiss(); presentation = null; }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
