'use strict';

const path = require('path');
const ModuleFilenameHelpers = require('webpack/lib/ModuleFilenameHelpers');
const webpack = require('webpack');
const webpackSources = webpack.sources || require('webpack-sources');
const yazl = require('yazl');

function ZipPlugin(options) {
  this.options = options || {};
}

ZipPlugin.prototype.apply = function (compiler) {
  const options = this.options;
  const isWebpack4 = webpack.version.startsWith('4.');
  // Prefer `compiler.webpack` instead of webpack or webpack-sources import (rspack compatibility hack)
  const { RawSource } = (compiler.webpack && compiler.webpack.sources) || webpackSources;

  if (options.pathPrefix && path.isAbsolute(options.pathPrefix)) {
    throw new Error('"pathPrefix" must be a relative path');
  }

  const process = function (compilation, callback) {
    // assets from child compilers will be included in the parent
    // so we should not run in child compilers
    if (compilation.compiler.isChild()) {
      callback();
      return;
    }

    const zipFile = new yazl.ZipFile();

    const pathPrefix = options.pathPrefix || '';
    const pathMapper =
      options.pathMapper ||
      function (x) {
        return x;
      };

    // populate the zip file with each asset
    for (const nameAndPath of Object.keys(compilation.assets)) {
      // match against include and exclude, which may be strings, regexes, arrays of the previous or omitted
      if (!ModuleFilenameHelpers.matchObject({ include: options.include, exclude: options.exclude }, nameAndPath)) continue;

      const source = compilation.assets[nameAndPath].source();

      zipFile.addBuffer(
        Buffer.isBuffer(source) ? source : Buffer.from ? Buffer.from(source) : new Buffer(source),
        path.join(pathPrefix, pathMapper(nameAndPath)),
        options.fileOptions
      );
    }

    zipFile.end(options.zipOptions);

    // accumulate each buffer containing a part of the zip file
    const bufs = [];

    zipFile.outputStream.on('data', function (buf) {
      bufs.push(buf);
    });

    zipFile.outputStream.on('end', function () {
      // default to webpack's root output path if no path provided
      const outputPath = options.path || compilation.options.output.path;
      // default to webpack root filename if no filename provided, else the basename of the output path
      let outputFilename = options.filename || compilation.options.output.filename || path.basename(outputPath);

      const fullHash = compilation.fullHash || compilation.hash;
      outputFilename = outputFilename.replace('[fullhash:6]', fullHash.slice(0, 6));

      const extension = '.' + (options.extension || 'zip');

      // combine the output path and filename
      const outputPathAndFilename = path.resolve(
        compilation.options.output.path, // ...supporting both absolute and relative paths
        outputPath,
        path.basename(outputFilename, '.zip') + extension // ...and filenames with and without a .zip extension
      );

      // resolve a relative output path with respect to webpack's root output path
      // since only relative paths are permitted for keys in `compilation.assets`
      const relativeOutputPath = path.relative(compilation.options.output.path, outputPathAndFilename);

      // add our zip file to the assets
      const zipFileSource = new RawSource(Buffer.concat(bufs));
      if (isWebpack4) {
        compilation.assets[relativeOutputPath] = zipFileSource;
      } else {
        compilation.emitAsset(relativeOutputPath, zipFileSource);
      }

      callback();
    });
  };

  if (isWebpack4) {
    compiler.hooks.emit.tapAsync(ZipPlugin.name, process);
  } else {
    compiler.hooks.thisCompilation.tap(ZipPlugin.name, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: ZipPlugin.name,
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER
        },
        () => new Promise((resolve) => process(compilation, resolve))
      );
    });
  }
};

exports.ZipPlugin = ZipPlugin;
