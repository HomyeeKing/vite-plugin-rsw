import path from 'path';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { spawnSync, exec } from 'child_process';
import type { ViteDevServer } from 'vite';

import fmtRustError from './rserr';
import { wpCmd, npmCmd, debugRsw, sleep, getCrateName, checkMtime, watch, watchDeps } from './utils';
import { CompileOneOptions, RswCompileOptions, RswPluginOptions, RswCrateOptions, NpmCmdType, CliType } from './types';

const cacheMap = new Map<string, string>();

function compileOne(options: CompileOneOptions) {
  const { config, crate, sync, serve, filePath, root = '', outDir } = options;

  // 🚀 build release please use: https://github.com/lencx/rsw-node
  const args = ['build'];

  let rswCrate: string;
  let pkgName: string;
  let scope: string | undefined;

  rswCrate = getCrateName(crate);

  if (rswCrate.startsWith('@')) {
    const a = rswCrate.split(/@|\//);
    scope = a[1];
    pkgName = `${scope}~${a[2]}`;
  } else {
    pkgName = rswCrate;
  }

  args.push('--out-name', `"${pkgName}"`);
  if (scope) args.push('--scope', `"${scope}"`);
  if (outDir) args.push('--out-dir', `"${outDir}"`);

  if (!config.profile && !(crate as RswCrateOptions)?.profile) args.push('--dev');
  if (!config.target && !(crate as RswCrateOptions)?.target) args.push('--target', 'web');
  if (config.target && !(crate as RswCrateOptions)?.target) args.push('--target', config.target);
  if (config.profile && !(crate as RswCrateOptions)?.profile) args.push(`--${config.profile}`);

  if (typeof crate === 'object') {
    if (crate.profile) args.push(`--${crate.profile}`);
    if (crate.target) args.push('--target', `"${crate.target}"`);
    if (crate.mode) args.push('--mode', `"${crate.mode}"`);
    if (crate.extraOpts) args.push(...(crate.extraOpts || []));
  }

  debugRsw(`[wasm-pack build]: ${args.join(' ')}`);

  // rust crates: custom path
  const crateRoot = path.resolve(root, rswCrate);

  if (sync) {
    let p = spawnSync(wpCmd, args, {
      shell: true,
      cwd: crateRoot,
      encoding: 'utf-8',
      stdio: 'inherit',
    });
    // fix: error exit
    if (p.status !== 0) {
      console.log(chalk.red(`[rsw::error] wasm-pack for crate ${rswCrate} failed.`));
      process.exit();
    }
  } else {
    exec(`${wpCmd} ${args.join(' ')}`, { cwd: crateRoot }, (err, _, stderr) => {
      // fix: no error, returns
      if (!err) {
        serve && serve.ws.send({ type: 'custom', event: 'rsw-error-close' });
        return;
      }

      if (stderr) {
        const { msgTag, msgCmd } = fmtRustError(stderr);
        console.log(msgCmd);
        console.log(chalk.red(`[rsw::error] wasm-pack for crate ${rswCrate} failed.`));

        serve && serve.ws.send({
          type: 'custom',
          event: 'rsw-error',
          data: {
            plugin: '[vite::rsw]',
            message: msgTag,
            id: filePath,
            console: stderr,
          },
        });
      }
    });
  }
}

export function rswCompile(options: RswCompileOptions) {
  const { config, root, crate, serve, filePath, npmType = 'link', cratePathMap } = options;
  const { crates, unLinks, cli = 'npm', ...opts } = config;

  const pkgsLink = (isRun: boolean = true) => {
    // compile & npm link
    const pkgMap = new Map<string, string>();
    crates.forEach((_crate) => {
      const _name = getCrateName(_crate);
      const srcPath = path.resolve(root, _name, 'src');
      const outDir = cratePathMap?.get(_name) || '';
      const cargoPath = path.resolve(root, _name, 'Cargo.toml');

      // vite startup optimization
      isRun && checkMtime(
        srcPath,
        cargoPath,
        path.join(outDir, 'package.json'),
        () => compileOne({ config: opts, crate: _crate, sync: true, root, outDir: cratePathMap?.get(_name) }),
        () => console.log(chalk.yellow(`[rsw::optimized] wasm-pack build ${_name}.`)),
      );

      // rust crates map
      pkgMap.set(_name, outDir);
    })

    rswPkgsLink(pkgMap, npmType, cli);

    console.log(chalk.green(`\n[rsw::${cli}::${npmType}]`));
    pkgMap.forEach((val, key) => {
      console.log(
        chalk.yellow(`  ↳ ${key} `),
        chalk.blue(` ${val} `)
      );
    });
    console.log();
  }

  // package.json dependency changes, re-run `npm link`.
  const pkgJson = path.resolve(root, 'package.json');
  if (filePath === pkgJson) {
    const oData = cacheMap.get('pkgJson');
    const data = readFileSync(pkgJson, { encoding: 'utf-8' });
    const jsonData = JSON.parse(data);
    const nData = JSON.stringify({ ...(jsonData.dependencies || {}), ...(jsonData.devDependencies || {}) })

    if (oData !== nData) {
      console.log(chalk.blue(`\n[rsw::${cli}::relink]`));
      sleep(1000);
      pkgsLink(false);
      cacheMap.set('pkgJson', nData);
    }
    return;
  }

  // watch: file change
  if (typeof crate === 'string') {
    compileOne({ config: opts, crate, sync: false, serve, filePath, root, outDir: cratePathMap?.get(crate) });
    return;
  }

  // init
  // npm unlink
  if (unLinks && unLinks.length > 0) {
    rswPkgsLink(unLinks.join(' '), 'unlink', cli);
    console.log();
    console.log(
      chalk.red(`\n[rsw::${cli}::unlink]\n`),
      chalk.blue(`  ↳ ${unLinks.join(' \n  ↳ ')} \n`)
    );
  }

  pkgsLink();
}

export function rswWatch(config: RswPluginOptions, root: string, serve: ViteDevServer, cratePathMap: Map<string, string>) {
  const _root = path.join('**', config.root || '');
  let _unwatch = config?.unwatch?.map((i) => path.join(_root, i)) || [];

  watch({
    type: 'repo',
    unwatch: [],
    paths: [path.resolve(root, 'package.json')],
    callback: (_path) => {
      rswCompile({ config, root, serve, filePath: _path, cratePathMap });
    },
  });

  config.crates.forEach((crate: string | RswCrateOptions) => {
    const name = getCrateName(crate);
    if (typeof crate === 'object') {
      const _crate = crate as RswCrateOptions;
      const _paths = _crate?.unwatch?.map((i) => path.join(_root, name, i));
      _unwatch = [...new Set(_unwatch.concat(_paths || []))];
    }

    // One-liner for current directory
    // https://github.com/paulmillr/chokidar
    watch({
      type: 'crate',
      unwatch: _unwatch,
      paths: [
        path.resolve(root, name, 'src'),
        path.resolve(root, name, 'Cargo.toml'),
      ],
      callback: (_path) => {
        rswCompile({ config, root, crate, serve, filePath: _path, cratePathMap });
      },
    });
    watchDeps(name, _unwatch, (_path) => {
      rswCompile({ config, root, crate, serve, filePath: _path, cratePathMap });
    });
  })

  if (_unwatch.length > 0) {
    console.log(
      chalk.blue(`[rsw::unwatch]\n${chalk.yellow(JSON.stringify(_unwatch, null, 2))}`),
    );
  }
}

function rswPkgsLink(pkgs: string | Map<string, string>, type: NpmCmdType, cli: CliType) {
  const npm = npmCmd(cli);
  let pkgLinks = pkgs;

  // fix: https://github.com/lencx/vite-plugin-rsw/issues/11
  if (typeof pkgs !== 'string') {
    // fix: https://github.com/lencx/vite-plugin-rsw/issues/20
    // whitespaces in project path do not work
    pkgLinks = Array.from(pkgs.values()).map((i) => `"${i}"`).join(' ');
    spawnSync(npm, ['unlink', '-g', Array.from(pkgs.keys()).join(' ')], {
      shell: true,
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  }

  spawnSync(npm, [type, (pkgLinks as string)], {
    shell: true,
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}
