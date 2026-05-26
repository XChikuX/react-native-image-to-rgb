project(NitroAiImage)
cmake_minimum_required(VERSION 3.9.0)

set(PACKAGE_NAME NitroAiImage)
set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(${PACKAGE_NAME} SHARED
  src/main/cpp/cpp-adapter.cpp
)

# Pull in Nitrogen-generated sources, JNI glue, specs, etc.
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroAiImage+autolinking.cmake)

#
# Force-link NitroModules.
# Some Expo/EAS + Prefab builds expose the target headers but fail to attach
# the backing shared library, causing unresolved margelo::nitro::* symbols.
#

if(TARGET react-native-nitro-modules::NitroModules)
  message(STATUS "[NitroAiImage] Using Nitro Prefab target")

  target_link_libraries(${PACKAGE_NAME}
    react-native-nitro-modules::NitroModules
  )

else()
  message(WARNING "[NitroAiImage] Nitro Prefab target missing — attempting manual .so fallback")

  set(NITRO_SO_PATH "")

  file(GLOB_RECURSE NITRO_CANDIDATES
    "${CMAKE_SOURCE_DIR}/../node_modules/**/libNitroModules.so"
    "${CMAKE_SOURCE_DIR}/../../node_modules/**/libNitroModules.so"
  )

  list(LENGTH NITRO_CANDIDATES NITRO_COUNT)

  if(NITRO_COUNT GREATER 0)
    list(GET NITRO_CANDIDATES 0 NITRO_SO_PATH)

    message(STATUS "[NitroAiImage] Found fallback Nitro .so:")
    message(STATUS "  ${NITRO_SO_PATH}")

    target_link_libraries(${PACKAGE_NAME}
      ${NITRO_SO_PATH}
    )

  else()
    message(FATAL_ERROR
      "[NitroAiImage] Could not locate react-native-nitro-modules native library. "
      "Ensure react-native-nitro-modules is installed and exported correctly."
    )
  endif()
endif()

find_library(LOG_LIB log)

target_link_libraries(${PACKAGE_NAME}
  ${LOG_LIB}
  android
)
