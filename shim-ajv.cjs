// shim-ajv.cjs
// 目的：在 Node 24 下避免 protodef-validator 对 Ajv 的构造/URI 解析异常。
// 策略：如果正常 require('ajv') 得到函数就直接导出；否则强制加载内部 lib/ajv.js；再否则提供一个最小假的实例。

function makeFakeAjv(){
  return function Ajv(){
    return {
      addSchema(){},
      validate(){ return true },
      errors: []
    }
  }
}

let exported;
try {
  const ajv = require('ajv')
  if (typeof ajv === 'function') {
    exported = ajv
  } else {
    // 可能拿到的是对象，尝试内部文件
    exported = require(require.resolve('ajv/lib/ajv.js'))
  }
} catch (e) {
  try {
    exported = require(require.resolve('ajv/lib/ajv.js'))
  } catch (e2) {
    console.warn('[shim-ajv] fallback fake Ajv used:', e2?.message || e2)
    exported = makeFakeAjv()
  }
}

module.exports = exported
