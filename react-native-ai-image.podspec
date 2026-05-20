require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-ai-image"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.0" }
  s.source       = { :git => "https://github.com/XChikuX/react-native-image-to-rgb.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{h,m,mm,swift}",
  ]

  # Pull in all Nitrogen-generated specs, bridges, and configure C++/Swift interop.
  load "nitrogen/generated/ios/NitroImageToRgb+autolinking.rb"
  add_nitrogen_files(s)

  # React Native ≥ 0.71 helper that sets up Folly, JSI, RCT-Folly etc. for us.
  install_modules_dependencies(s) if respond_to?(:install_modules_dependencies, true)
end
