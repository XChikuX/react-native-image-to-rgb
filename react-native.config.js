module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        packageInstance: 'new ImageToRgbPackage()',
        packageImportPath: 'import com.imagetorgb.ImageToRgbPackage;',
      },
    },
  },
}
