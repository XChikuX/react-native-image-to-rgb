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
# We verify that the Prefab target actually resolves to a real .so; if not,
# we locate it manually in the Gradle intermediates or node_modules tree.
#

set(_NITRO_LINKED FALSE)

if(TARGET react-native-nitro-modules::NitroModules)
  # Check whether the imported target has a real library file attached.
  get_target_property(_NITRO_LOCATION react-native-nitro-modules::NitroModules IMPORTED_LOCATION)
  if(NOT _NITRO_LOCATION)
    get_target_property(_NITRO_LOCATION react-native-nitro-modules::NitroModules IMPORTED_LOCATION_RELEASE)
  endif()
  if(NOT _NITRO_LOCATION)
    get_target_property(_NITRO_LOCATION react-native-nitro-modules::NitroModules IMPORTED_LOCATION_DEBUG)
  endif()

  if(_NITRO_LOCATION AND EXISTS "${_NITRO_LOCATION}")
    message(STATUS "[NitroAiImage] Nitro Prefab target has valid .so: ${_NITRO_LOCATION}")
    target_link_libraries(${PACKAGE_NAME} react-native-nitro-modules::NitroModules)
    set(_NITRO_LINKED TRUE)
  else()
    message(WARNING "[NitroAiImage] Nitro Prefab target exists but library not found at: ${_NITRO_LOCATION}")
  endif()
endif()

if(NOT _NITRO_LINKED)
  message(STATUS "[NitroAiImage] Searching for libNitroModules.so manually...")

  # Try find_library first — respects CMAKE_FIND_ROOT_PATH (prefab dir) and
  # standard CMake search mechanisms.
  find_library(_NITRO_FIND_LIB NitroModules)
  if(_NITRO_FIND_LIB)
    message(STATUS "[NitroAiImage] find_library found: ${_NITRO_FIND_LIB}")
    set(_NITRO_SO_PATH "${_NITRO_FIND_LIB}")
  endif()

  if(NOT _NITRO_SO_PATH)
    # Search common locations: Gradle intermediates, transform caches, prefab
    # outputs, and node_modules.  In Expo/EAS builds the package sits at
    # <project>/node_modules/react-native-nitro-modules and its .so may live in
    # the .cxx, build/intermediates, or prefab output directories.
    #
    # CMAKE_SOURCE_DIR = <project>/node_modules/react-native-ai-image/android
    # so ../../react-native-nitro-modules = sibling in flat node_modules.

    # Determine the node_modules root (handles both flat and nested layouts)
    get_filename_component(_NODE_MODULES_DIR "${CMAKE_SOURCE_DIR}/../.." ABSOLUTE)

    # Collect search roots
    set(_SEARCH_ROOTS
      "${_NODE_MODULES_DIR}/react-native-nitro-modules/android"
      "${_NODE_MODULES_DIR}/../android/app/build/intermediates"
      "${_NODE_MODULES_DIR}/../build"
      "${CMAKE_SOURCE_DIR}/../node_modules/react-native-nitro-modules/android"
    )

    # Use NITRO_MODULES_DIR hint from build.gradle if available
    if(DEFINED NITRO_MODULES_DIR AND EXISTS "${NITRO_MODULES_DIR}")
      message(STATUS "[NitroAiImage] Using NITRO_MODULES_DIR hint: ${NITRO_MODULES_DIR}")
      list(INSERT _SEARCH_ROOTS 0 "${NITRO_MODULES_DIR}")
    endif()

    # Add CMAKE_FIND_ROOT_PATH (prefab output)
    if(CMAKE_FIND_ROOT_PATH)
      list(APPEND _SEARCH_ROOTS "${CMAKE_FIND_ROOT_PATH}")
    endif()

    foreach(_SEARCH_ROOT ${_SEARCH_ROOTS})
      if(EXISTS "${_SEARCH_ROOT}")
        file(GLOB_RECURSE _ROOT_CANDIDATES "${_SEARCH_ROOT}/libNitroModules.so")
        if(_ROOT_CANDIDATES)
          list(APPEND NITRO_CANDIDATES ${_ROOT_CANDIDATES})
        endif()
      endif()
    endforeach()
    # Filter candidates to match the current ABI
    set(_NITRO_SO_PATH "")
    foreach(_CANDIDATE ${NITRO_CANDIDATES})
      if(_CANDIDATE MATCHES "/${ANDROID_ABI}/")
        set(_NITRO_SO_PATH "${_CANDIDATE}")
        break()
      endif()
    endforeach()

    # If ABI-specific not found, try any candidate
    if(NOT _NITRO_SO_PATH AND NITRO_CANDIDATES)
      list(GET NITRO_CANDIDATES 0 _NITRO_SO_PATH)
    endif()
  endif()

  if(_NITRO_SO_PATH)
    message(STATUS "[NitroAiImage] Found fallback Nitro .so for ${ANDROID_ABI}:")
    message(STATUS "  ${_NITRO_SO_PATH}")

    # Create an imported target so we get proper linker handling
    add_library(NitroAiImage_NitroModules_fallback SHARED IMPORTED)
    set_target_properties(NitroAiImage_NitroModules_fallback PROPERTIES IMPORTED_LOCATION "${_NITRO_SO_PATH}")

    # Carry over include directories from the prefab target if available
    if(TARGET react-native-nitro-modules::NitroModules)
      get_target_property(_NITRO_INCLUDES react-native-nitro-modules::NitroModules INTERFACE_INCLUDE_DIRECTORIES)
      if(_NITRO_INCLUDES)
        set_target_properties(NitroAiImage_NitroModules_fallback PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${_NITRO_INCLUDES}")
      endif()
    endif()

    target_link_libraries(${PACKAGE_NAME} NitroAiImage_NitroModules_fallback)
  else()
    message(FATAL_ERROR
      "[NitroAiImage] Could not locate react-native-nitro-modules native library (libNitroModules.so). "
      "Ensure react-native-nitro-modules is installed and its native build has completed. "
      "ABI: ${ANDROID_ABI}"
    )
  endif()
endif()

find_library(LOG_LIB log)

target_link_libraries(${PACKAGE_NAME}
  ${LOG_LIB}
  android
)
