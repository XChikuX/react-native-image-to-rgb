#include <fbjni/fbjni.h>
#include <jni.h>

#include "NitroAiImageOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::aiimage::initialize(vm);
}
