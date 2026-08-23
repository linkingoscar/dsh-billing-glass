/**
 * 客户端 bundle 运行环境的环境声明（仅供类型检查；运行时由 Harness
 * 的 __ModuleLoader__ 与宿主页面提供这些全局能力）。
 *
 * runtime.js 通过 require("react") 取到的绑定来自宿主注入的模块加载器，
 * 这里给出与 src/client 使用面一致的最小类型。
 */

declare function require(id: string): unknown;

interface ModuleLoaderSpec {
	id: string;
	factory: (require: (id: string) => unknown) => { apply?: unknown; inject?: unknown };
}

interface Window {
	__ModuleLoader__: {
		load(spec: ModuleLoaderSpec): void;
	};
}

/** 宿主 React 绑定的最小使用面（见 src/client/runtime.js）。 */
declare module "react" {
	export type Dispatch<A> = (value: A | ((prev: A) => A)) => void;
	export interface RefObject<T> {
		current: T;
	}
	export function useState<S>(initial: S | (() => S)): [S, Dispatch<S>];
	export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	export function useLayoutEffect(effect: () => void, deps?: readonly unknown[]): void;
	export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
	export function useRef<T>(initial: T): RefObject<T>;
}

declare module "react/jsx-runtime" {
	// jsx(type, props, key?) / jsxs —— 属性值任意（样式对象/事件/hook 透传），
	// 精确元素树类型不属于本插件的检查目标。
	export function jsx(type: unknown, props: Record<string, unknown>, key?: string | number): unknown;
	export function jsxs(type: unknown, props: Record<string, unknown>, key?: string | number): unknown;
	export const Fragment: unique symbol;
}
