package com.suenodeluna.lunadisplay;

import android.app.Presentation;
import android.content.Context;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Dibuja display.html (el pedido en vivo) dentro de la pantalla secundaria
    fisica del equipo, usando la Presentation API de Android -- la unica forma
    real de mandar contenido a esa pantalla (no es una ventana de navegador
    arrastrable como en Windows/Mac). */
public class SecondScreenPresentation extends Presentation {
    private static final String URL = "https://lunasmart-pos.netlify.app/display.html?suc=cafeteria";

    public SecondScreenPresentation(Context outerContext, Display display) {
        super(outerContext, display);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = new WebView(getContext());
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Sin esto, el WebView puede quedarse sirviendo una version vieja de
        // display.html (y por lo tanto sin el logo/promos/bienvenida al
        // cliente que se agregaron despues) en vez de bajar la mas reciente.
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.clearCache(true);
        webView.loadUrl(URL + "?_t=" + System.currentTimeMillis());
        setContentView(webView);
    }
}
