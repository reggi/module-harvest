var dotty = require('dotty')
var debug = require('debug')('module-harvest')
var _ = require('lodash')
var R = require('ramda')
var path = require('path')
var Promise = require('bluebird')
var fs = Promise.promisifyAll(require('fs-extra'))
var packageDeps = require('./package-deps')

/**
 * Build a module from file.
 * Tracks down package dependencies, and local, main, and bin files.
 * @param  {string} mainFile    Path to the main javascript file.
 * @param  {string} moduleName  Name of the module.
 * @param  {string} testDir     Directory where all the tests are stored.
 * @param  {string} docsDir     Directory where all the docs are stored.
 * @param  {string} localDir    Directory where built modules are stored.
 * @param  {string} packagesDir Directory where backup package.json files go.
 * @param  {string} binDir      Directory where the bin files are stored.
 * @param  {string} readmeName  Name of readme files generated in built module (readme.md).
 * @param  {string} packageFile Path of parent pacakge.json file.
 */
function moduleHarvest (mainFile, moduleName, testDir, docsDir, localDir, packagesDir, binDir, readmeName, packageFile) {
  var paths = {}
  paths.main = path.join(mainFile)
  paths.name = (moduleName) ? path.join(moduleName) : path.join(path.basename(mainFile, path.extname(mainFile)))
  paths.testDir = (testDir) ? testDir : path.join('test')
  paths.docsDir = (docsDir) ? docsDir : path.join('docs')
  paths.localModulesDir = (localDir) ? localDir : path.join('local_modules')
  paths.packagesDir = (packagesDir) ? packagesDir : path.join('packages')
  paths.binDir = (binDir) ? binDir : path.join('bin')
  paths.package = (packageFile) ? path.join(packageFile) : path.join('package.json')
  paths.readmeName = (readmeName) ? readmeName : path.join('readme.md')
  paths.nodeModulesDir = path.join('node_modules')
  paths.nodeModulesDirDst = path.join(paths.nodeModulesDir, paths.name)
  paths.localModulesDirDst = path.join(paths.localModulesDir, paths.name)
  paths.readmeSrc = path.join(paths.docsDir, paths.name + '.md')
  paths.readmeDst = path.join(paths.localModulesDirDst, paths.readmeName)
  paths.bin = path.join(paths.binDir, paths.main)
  paths.packageBackup = path.join(paths.packagesDir, 'package-' + paths.name + '.json')
  paths.packageDst = path.join(paths.localModulesDirDst, 'package.json')

  // var symlinks = []
  return packageDeps(paths.main, paths.package)
  .then(function (results) {
    return Promise.props({
      'readmeExists': fs.lstatAsync(paths.readme).then(R.T, R.F),
      'binExists': fs.lstatAsync(paths.bin).then(R.T, R.F)
    }).then(function (props) {
      return _.extend(results, props)
    })
  })
  .then(function (results) {
    var links = []
    links.push(results.testFiles)
    links.push(results.deps.local)
    links.push(results.binDeps.local)
    links.push(results.devDeps.local)
    links.push(results.deps.root)
    if (results.binExists) links.push(paths.bin)
    results.links = _.chain([links]).flattenDeep().unique().value()
    return results
  })
  .then(function (results) {
    var modulePackage = {}
    modulePackage.name = paths.name
    modulePackage.main = paths.main
    if (results.binExists) modulePackage.bin = paths.bin
    if (results.testFiles.length && dotty.exists(results, 'package.scripts.test')) dotty.put(modulePackage, 'scripts.test', results.package.scripts.test)
    if (results.package.author) modulePackage.author = results.package.author
    modulePackage.dependencies = results.pkgDeps.dependencies
    modulePackage.devDependencies = results.pkgDeps.devDependencies
    results.modulePackage = modulePackage
    return results
  })
  .then(function (results) {
    // make links
    var operations = {}
    return moduleHarvest.makeLinks(results.links, paths.localModulesDirDst)
    .then(function (links) {
      operations.links = links
      return operations
    })
    .then(function (operations) {
      // make package
      return moduleHarvest.writePackage(paths.packageDst, paths.packageBackup, results.modulePackage)
      .then(function (pkg) {
        operations.package = pkg
        return operations
      })
    })
    .then(function (operations) {
      // make symlinkModule
      return fs.ensureSymlinkAsync(paths.localModulesDirDst, paths.nodeModulesDirDst)
      .then(moduleHarvest.debugMsg('symlinked module %s -> %s', paths.localModulesDirDst, paths.nodeModulesDirDst))
      .catch(moduleHarvest.debugCatch)
      .then(function (symlinkModule) {
        operations.symlinkModule = symlinkModule
        return operations
      })
    })
    .then(function (operations) {
      // link readme
      return fs.ensureLinkAsync(paths.readmeSrc, paths.readmeDst)
      .then(moduleHarvest.debugMsg('link readme %s -> %s', paths.localModulesDirDst, paths.nodeModulesDirDst))
      .catch(moduleHarvest.debugCatch)
      .then(function (linkReadme) {
        operations.linkReadme = linkReadme
        return operations
      })
    })
  })
}

/** write pacakge from existing, backup, or generate fresh */
moduleHarvest.writePackage = function (packageDst, packageBackup, modulePackage) {
  return Promise.props({
    'backup': fs.readJsonAsync(packageBackup).catch(R.F),
    'destination': fs.readJsonAsync(packageDst).catch(R.F)
  }).then(function (pkg) {
    if (!pkg.destination) {
      return fs.writeJsonAsync(packageDst, modulePackage)
      .then(moduleHarvest.debugMsg('package written'))
      .catch(moduleHarvest.debugCatch)
    } else if (pkg.destination) {
      var updatedPackage = _.cloneDeep(pkg.destination)
      _.extend(updatedPackage, modulePackage)
      return fs.writeJsonAsync(packageDst, updatedPackage)
      .then(moduleHarvest.debugMsg('package destination updated'))
      .catch(moduleHarvest.debugCatch)
    } else if (pkg.backup) {
      var updatedPackageFromBackup = _.cloneDeep(pkg.backup)
      _.extend(updatedPackageFromBackup, modulePackage)
      return fs.writeJsonAsync(packageDst, updatedPackageFromBackup)
      .then(moduleHarvest.debugMsg('package restored and updated from backup'))
      .catch(moduleHarvest.debugCatch)
    } else {
      return fs.writeJsonAsync(packageDst, modulePackage)
      .then(moduleHarvest.debugMsg('package restored and updated from backup'))
      .catch(moduleHarvest.debugCatch)
    }
  })
  .then(function () {
    return fs.ensureLinkAsync(packageDst, packageBackup)
    .then(moduleHarvest.debugMsg('package backedup'))
    .catch(moduleHarvest.debugCatch)
  })
}

/** make hard links */
moduleHarvest.makeLinks = function (links, localModuleDirDst) {
  links = _.flattenDeep([links])
  return Promise.map(links, function (link) {
    var dstpath = path.join(localModuleDirDst, link)
    return fs.ensureLinkAsync(link, dstpath)
    .then(moduleHarvest.debugMsg('link ensured %s -> %s', link, dstpath))
    .catch(moduleHarvest.debugCatch)
  })
}

/** debug message from promise then */
moduleHarvest.debugMsg = function () {
  var args = Array.prototype.slice.call(arguments)
  return function (value) {
    debug.apply(null, args)
    return value
  }
}

/** catch message for debug from promise catch */
moduleHarvest.debugCatch = function (e) {
  debug(e.message)
  return false
}

module.exports = moduleHarvest