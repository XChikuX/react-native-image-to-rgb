// Post-nitrogen fixup: strip the `SWIFT_INSTALL_OBJC_HEADER => "NO"` line
// that nitrogen 0.35.7 unconditionally emits. It disables the Swift header
// that the C++/Swift bridge needs (`NitroAiImage-Swift.h`).
//
// Usage: node scripts/strip-swift-header-hack.js

const fs = require('fs')
const path = require('path')

const file = path.join(
  __dirname,
  '..',
  'nitrogen',
  'generated',
  'ios',
  'NitroAiImage+autolinking.rb'
)

if (!fs.existsSync(file)) {
  console.error('[strip-swift-header-hack] File not found:', file)
  process.exit(1)
}

let content = fs.readFileSync(file, 'utf8')
const before = content
content = content.replace(
  /^\s*"SWIFT_INSTALL_OBJC_HEADER"\s*=>\s*"NO"\s*,?\s*\n/gm,
  ''
)

if (content !== before) {
  fs.writeFileSync(file, content)
  console.log('[strip-swift-header-hack] Removed SWIFT_INSTALL_OBJC_HEADER => "NO"')
} else {
  console.log('[strip-swift-header-hack] No SWIFT_INSTALL_OBJC_HEADER line found (already clean)')
}
