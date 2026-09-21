/**
 * @opentui/solid 的 JSX 运行时垫片。
 *
 * @opentui/solid 只提供了 jsx-runtime 的类型声明，没有提供实际的 JS 模块。
 * 该垫片从 solid-js 重新导出标准 JSX 运行时函数，供 babel-preset-solid
 * 转换后的 OpenTUI 组件使用。
 */

// solid-js/jsx-runtime 导出：jsx, jsxs, Fragment
// solid-js 在开发模式下还会使用 jsxDEV
import { Fragment, jsx, jsxs } from "solid-js/h/jsx-runtime";

/**
 * 开发模式使用的 JSX 创建函数。
 *
 * @param type 组件类型或 HTML 标签名
 * @param props 组件属性
 * @param key 可选的 React/Solid key
 * @returns JSX 元素
 */
function jsxDEV(
  type: any,
  props: any,
  key?: string,
  _isStatic?: boolean,
  _source?: any,
  _self?: any,
) {
  if (key !== undefined) {
    return jsx(type, { ...props, key });
  }
  return jsx(type, props);
}

export { jsx, jsxs, jsxDEV, Fragment };
