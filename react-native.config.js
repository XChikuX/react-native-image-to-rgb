module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        packageInstance: 'new AiImagePackage()',
        packageImportPath: 'import com.aiimage.AiImagePackage;',
      },
    },
  },
}
