package com.imagetorgb

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.margelo.nitro.imagetorgb.NitroImageToRgbOnLoad

/**
 * Empty React Package that exists solely so React Native's autolinker picks us
 * up at app startup and triggers `NitroImageToRgbOnLoad.initializeNative()`,
 * which loads `libNitroImageToRgb.so` and registers the `ImageToRgb`
 * HybridObject with Nitro's registry.
 */
class ImageToRgbPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { HashMap() }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()

  companion object {
    init {
      NitroImageToRgbOnLoad.initializeNative()
    }
  }
}
