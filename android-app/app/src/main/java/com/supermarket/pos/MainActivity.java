package com.supermarket.pos;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.media.Image;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.AspectRatioStrategy;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.ResolutionSelector;
import androidx.camera.core.ResolutionStrategy;
import androidx.camera.core.ZoomState;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.ZoomSuggestionOptions;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class MainActivity extends AppCompatActivity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/assets/www/index.html";
    private static final int CAMERA_PERMISSION_REQUEST = 7101;
    private static final int FILE_CHOOSER_REQUEST = 7102;

    private FrameLayout root;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private FrameLayout scannerOverlay;
    private PreviewView previewView;
    private TextView scannerStatus;
    private Button torchButton;

    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private ImageAnalysis imageAnalysis;
    private BarcodeScanner barcodeScanner;
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();

    private boolean scannerActive = false;
    private boolean torchOn = false;
    private String scanMode = "sale";
    private String candidateValue = null;
    private String lockedValue = null;
    private int candidateCount = 0;
    private long noBarcodeSince = 0L;

    private ToneGenerator toneGenerator;
    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<String> saveBackupLauncher;
    private String pendingBackupJson;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(23, 63, 53));
        getWindow().setNavigationBarColor(Color.rgb(16, 45, 37));

        toneGenerator = new ToneGenerator(AudioManager.STREAM_MUSIC, 100);
        saveBackupLauncher = registerForActivityResult(
                new ActivityResultContracts.CreateDocument("application/json"),
                this::writeBackupToUri
        );

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        configureWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
        webView.loadUrl(APP_URL);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (scannerActive) stopScanner(true);
                else if (webView != null && webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
    }

    private void configureWebView() {
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);

        webView.setBackgroundColor(Color.WHITE);
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidScanner");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !APP_HOST.equals(request.getUrl().getHost());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "اختار ملف النسخة الاحتياطية"),
                            FILE_CHOOSER_REQUEST
                    );
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "تعذر فتح مدير الملفات", Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void startScan(String mode) {
            runOnUiThread(() -> {
                scanMode = "product".equals(mode) ? "product" : "sale";
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED) {
                    openScanner();
                } else {
                    ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[]{Manifest.permission.CAMERA},
                            CAMERA_PERMISSION_REQUEST
                    );
                }
            });
        }

        @JavascriptInterface
        public void stopScan() {
            runOnUiThread(() -> stopScanner(true));
        }

        @JavascriptInterface
        public void playSuccessBeep() {
            runOnUiThread(MainActivity.this::playSuccessBeep);
        }

        @JavascriptInterface
        public void playErrorBeep() {
            runOnUiThread(MainActivity.this::playErrorBeep);
        }

        @JavascriptInterface
        public void saveBackup(String json) {
            runOnUiThread(() -> {
                pendingBackupJson = json;
                String fileName = "supermarket-pos-backup-" + LocalDate.now() + ".json";
                saveBackupLauncher.launch(fileName);
            });
        }
    }

    private void writeBackupToUri(Uri uri) {
        if (uri == null || pendingBackupJson == null) {
            pendingBackupJson = null;
            return;
        }
        try (OutputStream output = getContentResolver().openOutputStream(uri)) {
            if (output == null) throw new IllegalStateException("تعذر فتح الملف للحفظ");
            output.write(pendingBackupJson.getBytes(StandardCharsets.UTF_8));
            Toast.makeText(this, "تم حفظ النسخة الاحتياطية", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "تعذر حفظ النسخة: " + e.getMessage(), Toast.LENGTH_LONG).show();
        } finally {
            pendingBackupJson = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                openScanner();
            } else {
                Toast.makeText(this, "يجب السماح باستخدام الكاميرا لمسح الباركود", Toast.LENGTH_LONG).show();
                notifyWebScannerClosed();
            }
        }
    }

    private void openScanner() {
        if (scannerActive) return;
        scannerActive = true;
        torchOn = false;
        candidateValue = null;
        candidateCount = 0;
        lockedValue = null;
        noBarcodeSince = 0L;

        showScannerOverlay();
        scannerStatus.setText("وجّه باركود المنتج داخل الصورة");
        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(() -> {
            try {
                cameraProvider = providerFuture.get();
                bindCameraUseCases();
                webView.evaluateJavascript(
                        "window.onNativeScannerReady && window.onNativeScannerReady()",
                        null
                );
            } catch (Exception e) {
                Toast.makeText(this, "تعذر تشغيل الكاميرا: " + e.getMessage(), Toast.LENGTH_LONG).show();
                stopScanner(true);
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void showScannerOverlay() {
        if (scannerOverlay != null) root.removeView(scannerOverlay);
        scannerOverlay = new FrameLayout(this);
        scannerOverlay.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        scannerOverlay.addView(previewView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setPadding(dp(18), dp(16), dp(18), dp(18));
        controls.setBackgroundColor(Color.argb(225, 16, 39, 31));

        TextView title = new TextView(this);
        title.setText("ماسح الباركود السريع");
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
        title.setGravity(Gravity.CENTER);
        controls.addView(title);

        scannerStatus = new TextView(this);
        scannerStatus.setText("وجّه الباركود إلى الكاميرا");
        scannerStatus.setTextColor(Color.rgb(220, 238, 228));
        scannerStatus.setTextSize(14);
        scannerStatus.setGravity(Gravity.CENTER);
        scannerStatus.setPadding(0, dp(8), 0, dp(8));
        controls.addView(scannerStatus);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        torchButton = new Button(this);
        torchButton.setText("تشغيل الفلاش");
        torchButton.setOnClickListener(v -> toggleTorch());
        Button closeButton = new Button(this);
        closeButton.setText("إغلاق الماسح");
        closeButton.setOnClickListener(v -> stopScanner(true));

        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(0, dp(48), 1f);
        buttonParams.setMargins(dp(4), dp(5), dp(4), 0);
        actions.addView(torchButton, buttonParams);
        actions.addView(closeButton, new LinearLayout.LayoutParams(0, dp(48), 1f));
        controls.addView(actions);

        FrameLayout.LayoutParams controlsParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
        );
        scannerOverlay.addView(controls, controlsParams);

        TextView guide = new TextView(this);
        guide.setText("أبعد العبوة بعد سماع الصفارة، ثم قرّب المنتج التالي");
        guide.setTextColor(Color.WHITE);
        guide.setTextSize(13);
        guide.setGravity(Gravity.CENTER);
        guide.setPadding(dp(8), dp(8), dp(8), dp(8));
        guide.setBackgroundColor(Color.argb(125, 23, 63, 53));
        FrameLayout.LayoutParams guideParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
        );
        scannerOverlay.addView(guide, guideParams);

        root.addView(scannerOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
    }

    private void bindCameraUseCases() throws Exception {
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        ResolutionSelector resolutionSelector = new ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(new ResolutionStrategy(
                        new Size(1280, 720),
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER
                ))
                .build();

        imageAnalysis = new ImageAnalysis.Builder()
                .setResolutionSelector(resolutionSelector)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
        imageAnalysis.setAnalyzer(analysisExecutor, this::analyzeFrame);

        cameraProvider.unbindAll();
        camera = cameraProvider.bindToLifecycle(
                this,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                imageAnalysis
        );

        if (barcodeScanner == null) barcodeScanner = createBarcodeScanner();

        previewView.post(() -> {
            if (camera != null && previewView.getWidth() > 0 && previewView.getHeight() > 0) {
                try {
                    MeteringPoint point = previewView.getMeteringPointFactory().createPoint(
                            previewView.getWidth() / 2f,
                            previewView.getHeight() / 2f
                    );
                    FocusMeteringAction focusAction = new FocusMeteringAction.Builder(point)
                            .setAutoCancelDuration(3, TimeUnit.SECONDS)
                            .build();
                    camera.getCameraControl().startFocusAndMetering(focusAction);
                } catch (Exception ignored) { }
            }
        });

        if (camera.getCameraInfo().hasFlashUnit()) torchButton.setEnabled(true);
        else {
            torchButton.setEnabled(false);
            torchButton.setText("الفلاش غير متاح");
        }
    }

    private BarcodeScanner createBarcodeScanner() {
        ZoomSuggestionOptions zoomOptions = new ZoomSuggestionOptions.Builder(zoomRatio -> {
            Camera activeCamera = camera;
            if (activeCamera == null) return false;
            ZoomState state = activeCamera.getCameraInfo().getZoomState().getValue();
            if (state == null) return false;
            float clamped = Math.max(state.getMinZoomRatio(), Math.min(zoomRatio, state.getMaxZoomRatio()));
            activeCamera.getCameraControl().setZoomRatio(clamped);
            return true;
        }).setMaxSupportedZoomRatio(4.0f).build();

        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                        Barcode.FORMAT_EAN_13,
                        Barcode.FORMAT_EAN_8,
                        Barcode.FORMAT_UPC_A,
                        Barcode.FORMAT_UPC_E,
                        Barcode.FORMAT_CODE_128,
                        Barcode.FORMAT_CODE_39,
                        Barcode.FORMAT_CODE_93,
                        Barcode.FORMAT_CODABAR,
                        Barcode.FORMAT_ITF,
                        Barcode.FORMAT_QR_CODE
                )
                .enableAllPotentialBarcodes()
                .setZoomSuggestionOptions(zoomOptions)
                .build();
        return BarcodeScanning.getClient(options);
    }

    private void analyzeFrame(ImageProxy imageProxy) {
        if (!scannerActive || barcodeScanner == null) {
            imageProxy.close();
            return;
        }
        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return;
        }
        try {
            InputImage inputImage = InputImage.fromMediaImage(
                    mediaImage,
                    imageProxy.getImageInfo().getRotationDegrees()
            );
            barcodeScanner.process(inputImage)
                    .addOnSuccessListener(ContextCompat.getMainExecutor(this), this::consumeBarcodes)
                    .addOnFailureListener(ContextCompat.getMainExecutor(this), error -> { })
                    .addOnCompleteListener(analysisExecutor, task -> imageProxy.close());
        } catch (Exception e) {
            imageProxy.close();
        }
    }

    private void consumeBarcodes(List<Barcode> barcodes) {
        if (!scannerActive) return;
        Barcode detected = null;
        for (Barcode barcode : barcodes) {
            if (barcode.getRawValue() != null && !barcode.getRawValue().trim().isEmpty()) {
                detected = barcode;
                break;
            }
        }

        long now = System.currentTimeMillis();
        if (detected == null) {
            candidateValue = null;
            candidateCount = 0;
            if (noBarcodeSince == 0L) noBarcodeSince = now;
            if (now - noBarcodeSince >= 1600L) {
                lockedValue = null;
                noBarcodeSince = 0L;
            }
            return;
        }

        String value = detected.getRawValue().trim();
        noBarcodeSince = 0L;
        if (value.equals(lockedValue)) {
            candidateValue = null;
            candidateCount = 0;
            return;
        }
        if (value.equals(candidateValue)) candidateCount++;
        else {
            candidateValue = value;
            candidateCount = 1;
        }

        if (candidateCount >= 2) {
            lockedValue = value;
            candidateValue = null;
            candidateCount = 0;
            if (scannerStatus != null) {
                scannerStatus.setText("تمت قراءة: " + value + " — ارفع المنتج للانتقال للتالي");
            }
            String safeValue = JSONObject.quote(value);
            String safeFormat = JSONObject.quote(formatName(detected.getFormat()));
            webView.post(() -> webView.evaluateJavascript(
                    "window.onNativeBarcodeScanned && window.onNativeBarcodeScanned("
                            + safeValue + "," + safeFormat + ")",
                    null
            ));
        }
    }

    private String formatName(int format) {
        switch (format) {
            case Barcode.FORMAT_EAN_13: return "ean_13";
            case Barcode.FORMAT_EAN_8: return "ean_8";
            case Barcode.FORMAT_UPC_A: return "upc_a";
            case Barcode.FORMAT_UPC_E: return "upc_e";
            case Barcode.FORMAT_CODE_128: return "code_128";
            case Barcode.FORMAT_CODE_39: return "code_39";
            case Barcode.FORMAT_CODE_93: return "code_93";
            case Barcode.FORMAT_CODABAR: return "codabar";
            case Barcode.FORMAT_ITF: return "itf";
            case Barcode.FORMAT_QR_CODE: return "qr_code";
            default: return "unknown";
        }
    }

    private void toggleTorch() {
        if (camera == null || !camera.getCameraInfo().hasFlashUnit()) return;
        torchOn = !torchOn;
        camera.getCameraControl().enableTorch(torchOn);
        if (torchButton != null) torchButton.setText(torchOn ? "إيقاف الفلاش" : "تشغيل الفلاش");
    }

    private void stopScanner(boolean notifyWeb) {
        scannerActive = false;
        torchOn = false;
        if (cameraProvider != null) {
            try { cameraProvider.unbindAll(); } catch (Exception ignored) { }
        }
        camera = null;
        imageAnalysis = null;
        if (scannerOverlay != null) {
            root.removeView(scannerOverlay);
            scannerOverlay = null;
            previewView = null;
            scannerStatus = null;
            torchButton = null;
        }
        if (notifyWeb) notifyWebScannerClosed();
    }

    private void notifyWebScannerClosed() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.onNativeScannerClosed && window.onNativeScannerClosed()",
                    null
            );
        }
    }

    private void playSuccessBeep() {
        if (toneGenerator == null) return;
        toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP2, 105);
        mainHandler.postDelayed(() -> {
            if (toneGenerator != null) toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP2, 105);
        }, 115);
    }

    private void playErrorBeep() {
        if (toneGenerator != null) toneGenerator.startTone(ToneGenerator.TONE_PROP_NACK, 220);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onPause() {
        if (scannerActive) stopScanner(true);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopScanner(false);
        if (barcodeScanner != null) {
            try { barcodeScanner.close(); } catch (Exception ignored) { }
            barcodeScanner = null;
        }
        if (toneGenerator != null) {
            toneGenerator.release();
            toneGenerator = null;
        }
        analysisExecutor.shutdown();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
