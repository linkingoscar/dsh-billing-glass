// 框架运行时：所有 UI 模块共享的 react/jsx 绑定。
const reactRuntime = require("react");
const jsxRuntime = require("react/jsx-runtime");
export const useState = reactRuntime.useState;
export const useEffect = reactRuntime.useEffect;
export const useLayoutEffect = reactRuntime.useLayoutEffect;
export const useCallback = reactRuntime.useCallback;
export const useRef = reactRuntime.useRef;
export const jsx = jsxRuntime.jsx;
export const jsxs = jsxRuntime.jsxs;
export const Fragment = jsxRuntime.Fragment;
