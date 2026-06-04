// scripts/unpublish.js
const fs = require('fs');
const { execSync } = require('child_process');
const pkg = require('../package.json');

const name = pkg.name;
const version = process.argv[2] || pkg.version;
const tag = `v${version}`;

console.log(`\n🗑️  Unpublishing ${name}@${version}...\n`);

// 1. 撤销 npm 包
try {
  execSync(`npm unpublish ${name}@${version} --force`, { stdio: 'inherit' });
  console.log(`✅ npm 撤销成功\n`);
} catch (e) {
  console.log(`⚠️ npm 撤销失败（可能已撤销或超时）\n`);
}

// 2. 删除 git tag
try { execSync(`git tag -d ${tag}`, { stdio: 'pipe' }); console.log(`✅ 本地 tag ${tag} 已删除`); }
catch (e) { console.log(`⚠️ 本地 tag ${tag} 不存在`); }

try { execSync(`git push origin :refs/tags/${tag}`, { stdio: 'pipe' }); console.log(`✅ 远程 tag ${tag} 已删除`); }
catch (e) { console.log(`⚠️ 远程 tag ${tag} 不存在或无权限`); }

// 3. ⭐ 回退 package.json 版本（patch 级别减 1）
const parts = version.split('.').map(Number);
parts[2] = Math.max(0, parts[2] - 1); // patch - 1，最低为 0
const newVersion = parts.join('.');

pkg.version = newVersion;
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log(`\n📦 package.json 版本已回退: ${version} → ${newVersion}`);
console.log(`🎉 清理完成！现在可以重新 publish:patch 了\n`);