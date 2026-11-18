#!/usr/bin/env node
/**
 * 把各资源包的 pack.json 汇总为小程序可 require 的模块。
 *
 * 小程序端不保证支持 require 任意 .json 文件，因此由构建脚本把 pack.json
 * 内联成 registry.js。pack.json 仍是唯一数据源，registry.js 不参与手改。
 *
 * 用法：node tools/build-pack.js
 */

const fs = require('fs');
const path = require('path');

const MP_DIR = path.resolve(__dirname, '..', 'web');
const PACKS_DIR = path.join(MP_DIR, 'packs');
const COVERS_DIR = path.join(MP_DIR, 'covers');
const APP_JSON = path.join(MP_DIR, 'app.json');
const OUT = path.join(PACKS_DIR, 'registry.js');

/**
 * 每个内置包都是一个资源分包：root=packs/{id}、name=pack-{id}。
 * 新增包忘了写 app.json 时给出提示，避免真机上分包加载不到。
 */
function checkLayout(packs) {
  let app;
  try {
    app = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  } catch (err) {
    console.warn('[警告] 无法读取 app.json：' + err.message);
    return;
  }

  const declared = {};
  (app.subPackages || app.subpackages || []).forEach((item) => {
    if (item && item.name) declared[item.name] = item.root;
  });

  packs.forEach((pack) => {
    const root = 'packs/' + pack.id;
    const name = 'pack-' + pack.id;
    if (declared[name] !== root) {
      console.warn(`[警告] app.json 未声明资源分包 ${name}（root 应为 ${root}）`);
    }
    if (!fs.existsSync(path.join(COVERS_DIR, pack.id + '.jpg'))) {
      console.warn(`[警告] 缺少主包封面 covers/${pack.id}.jpg，请执行 python tools/build-covers.py`);
    }
  });
}

/**
 * 小程序不能动态 require 文本文件，v2 正文在构建期内联进 registry。
 * pack.json 仍是唯一数据源，registry 里的 bodies 只是派生物。
 */
function withBodies(pack, dir) {
  const scenes = Array.isArray(pack.scenes) ? pack.scenes : [];
  const bodies = {};
  scenes.forEach((scene) => {
    if (!scene || !scene.id) return;
    const rel =
      typeof scene.body === 'string'
        ? scene.body
        : scene.body && scene.body['zh-CN'];
    if (!rel) return;
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) return;
    bodies[scene.id] = fs.readFileSync(file, 'utf8');
  });
  if (Object.keys(bodies).length) pack.bodies = bodies;
  return pack;
}

function main() {
  const packs = fs
    .readdirSync(PACKS_DIR)
    .map((name) => path.join(PACKS_DIR, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .map((dir) => {
      const file = path.join(dir, 'pack.json');
      if (!fs.existsSync(file)) return null;
      return withBodies(JSON.parse(fs.readFileSync(file, 'utf8')), dir);
    })
    .filter(Boolean);

  const body = [
    '// 此文件由 tools/build-pack.js 生成，请勿手动修改。',
    '// 数据源：web/packs/*/pack.json',
    'module.exports = ' + JSON.stringify(packs, null, 2) + ';',
    '',
  ].join('\n');

  fs.writeFileSync(OUT, body, 'utf8');
  console.log(`已生成 ${path.relative(process.cwd(), OUT)}，共 ${packs.length} 个资源包`);
  checkLayout(packs);
}

main();
