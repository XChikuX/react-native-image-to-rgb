package com.aiimage

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.margelo.nitro.aiimage.NitroAiImageOnLoad

/**
 * Empty React Package that exists solely so React Native's autolinker picks us
 * up at app startup and triggers `NitroAiImageOnLoad.initializeNative()`,
 * which loads `libNitroAiImage.so` and registers the `AiImage` HybridObject
 * with Nitro's registry.
 *
 * Distinct package + class name from the legacy
 * `react-native-image-to-rgb`'s `com.imagetorgb.ImageToRgbPackage` so both
 * libraries can be installed in the same app without `BuildConfig` / dex
 * collisions.
 */
class AiImagePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { HashMap() }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()

  companion object {
    init {
      NitroAiImageOnLoad.initializeNative()
    }
  }
}
