import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import App from './App'

// 避免测试时真实发网络请求
vi.spyOn(global, 'fetch' as any).mockResolvedValue({
  ok: true,
  json: async () => ({ resourceType: 'Bundle' })
} as any)

// 避免测试时真实调用摄像头
vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    async decodeOnceFromVideoDevice () { return { getText: () => 'MOCK-CODE-123' } }
    reset () {}
  }
}))

describe('App smoke test', () => {
  it('renders without crashing and shows at least one top-level nav label', async () => {
    render(<App />)

    // 顶部导航常见候选文案（英文/中文都试一下）
    const candidates = [/home/i, /equipment/i, /stock/i, /used list/i, /保存|库存|使用记录/]

    // allow multiple matches (e.g., multiple "Equipment" buttons/labels)
    const foundOne = candidates.some((re) => screen.queryAllByText(re).length > 0)
    expect(foundOne).toBe(true)
  })
})
