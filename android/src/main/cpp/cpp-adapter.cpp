#include <fbjni/fbjni.h>
#include <jni.h>

#include "NitroImageToRgbOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::imagetorgb::initialize(vm);
}
