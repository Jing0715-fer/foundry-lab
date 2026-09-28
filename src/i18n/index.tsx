'use client'

// MolVision 国际化核心（i18n）
// ─────────────────────────────────────────────────────────────────────────────
// 设计决策（r62）：
// 1. **inline DualText**（`t({ zh, en })`）而非中央字典键 —— 并行改造零键名协调、
//    grep 可达、类型安全、后续加语言只需加字段。
// 2. **cookie 为唯一持久源**（molvision-locale），SSR 由 layout 直读 —— 首屏即正确语言，
//    无 localStorage hydrate 闪烁；zustand 内存 store 供事件时求值。
// 3. **worker 安全**：store 不用 persist/localStorage（Worker 上下文可安全 import tt），
//    document 访问全部守卫；Worker 内默认 zh，需要时经请求载荷线程化 locale。
// 4. `tt()` 面向事件时（lib 命令输出/toast/错误），`useI18n().t` 面向 React 渲染期
//    （订阅 locale，切换即重渲）。
//
// 设计决策（r64-a · SSR 首屏真直出，r63-review-b P1-1）：
// 5. **渲染期 locale 走 LocaleContext 直传**。zustand v5 的 useSyncExternalStore 在
//    SSR/水合期取 `getInitialState()` 快照——store 创建时冻结的 'zh'，渲染期 setLocale
//    写 store 无法影响服务端快照 → 旧实现 SSR 正文恒中文，水合后靠订阅翻转为英文。
//    现由 I18nProvider 以 `useState(initialLocale)` 为渲染期状态源（SSR 与客户端首渲染
//    执行同一 prop → 服务端正文按请求语言直出，且零 hydration mismatch）。
// 6. **zustand store 仍是运行时真相源**：tt() 事件时求值、map-load 等非组件路径直读、
//    store.ts 引导日志订阅均不受影响。Provider 在首渲染（useState 初始化器）把
//    initialLocale 镜像进 store，此后每次切换双写（store + ctx）保持两处同步。
//    刻意不让 store 创建时读 document.cookie：那会使客户端 getInitialState()('en') 与
//    服务端('zh')不对称，未来任何 `useI18nStore(s => s.locale)` 渲染期订阅者都将水合
//    错配；保持创建态恒 'zh' 则直订者水合 zh→zh 一致，挂载后经订阅校正。
import { create } from 'zustand'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { LOCALE_COOKIE, type Locale, type DualText } from './locales'

export type { Locale, DualText } from './locales'
export { LOCALE_COOKIE } from './locales'

export type TranslateInput = DualText | string

interface I18nState {
  locale: Locale
  /** 切换语言：更新 store + <html lang> + cookie（persist:false 供 SSR 初始化） */
  setLocale: (locale: Locale, opts?: { persist?: boolean }) => void
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: 'zh',
  setLocale: (locale, opts) => {
    set({ locale })
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
      if (opts?.persist !== false) {
        document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=31536000;samesite=lax`
      }
    }
  },
}))

/** 事件时翻译（非 React 渲染期）：lib 层命令输出、toast、throw 的错误消息等 */
export function tt(text: TranslateInput): string {
  if (typeof text === 'string') return text
  return useI18nStore.getState().locale === 'en' ? text.en : text.zh
}

/**
 * 事件时 locale 直读（r65-c：数字/时间格式化接线）——`n.toLocaleString(loc())`
 * 让命令输出、toast 等非渲染期数字随界面语言而非浏览器语言格式化。
 * 渲染期请用 useI18n().locale（ctx）；Worker 内默认 zh（与 tt() 同语义）。
 */
export function loc(): Locale {
  return useI18nStore.getState().locale
}

/**
 * 渲染期 locale 直传通道（r64-a）：SSR 与客户端首渲染同以 I18nProvider 的
 * initialLocale 执行。默认值仅兜底 Provider 外误用（生产树内不可能发生）。
 */
const LocaleCtx = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({
  locale: 'zh',
  setLocale: () => {},
})

/** React 渲染期翻译钩子：locale 订阅自 LocaleCtx —— SSR 直出请求语言，切换即全局重渲 */
export function useI18n() {
  const { locale, setLocale } = useContext(LocaleCtx)
  const t = useCallback(
    (text: TranslateInput) => (typeof text === 'string' ? text : locale === 'en' ? text.en : text.zh),
    [locale],
  )
  return { locale, setLocale, t }
}

/**
 * SSR 直出 Provider：layout（server）读 cookie/accept-language 后传入 initialLocale。
 * useState(initialLocale) 为渲染期状态源——SSR 与客户端首渲染以相同 prop 执行 →
 * SSR HTML 按请求语言直出、零 hydration mismatch、无语言闪烁。切换语言时 setLocale
 * 双写 store（真相源 + <html lang> + cookie 持久化）与 ctx（驱动消费组件重渲染），
 * 下次首屏 SSR 直读 cookie。
 */
export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale
  children: ReactNode
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    // 首渲染（SSR + 客户端水合）把请求语言镜像进 zustand store：
    // · SSR：写 store 不影响 useSyncExternalStore 的 getInitialState() 快照（渲染走
    //   ctx，无跨请求泄漏）；store.ts 引导日志订阅在此同步触发，早于 ConsoleBar 读取
    // · 客户端：tt()/store 直连方在挂载前即读到正确语言（引导日志无水合闪烁）
    const s = useI18nStore.getState()
    if (s.locale !== initialLocale) s.setLocale(initialLocale, { persist: false })
    return initialLocale
  })
  const setLocale = useCallback((next: Locale) => {
    useI18nStore.getState().setLocale(next) // 真相源镜像 + <html lang> + cookie 持久化
    setLocaleState(next) // ctx 状态源 → 全部 useI18n 消费组件重渲染
  }, [])
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>
}
