import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import App from './App'

// Mock camera + fetch to avoid side effects
vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    static async listVideoInputDevices () { return [{ deviceId: 'mock' }] }
    async decodeFromVideoDevice () { return }
    reset () {}
  }
}))

vi.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => ({}) } as any)

describe('App navigation', () => {
  it('navigates between Equipment, Stock, and Used views', async () => {
    render(<App />)

    // Go to Stock
    fireEvent.click(screen.getAllByText(/stock/i)[0])
    expect(await screen.findByText(/Stock Management/i)).toBeTruthy()

    // Go to Equipment
    fireEvent.click(screen.getAllByText(/equipment/i)[0])
    expect(await screen.findByText(/Save Medical Device to FHIR/i)).toBeTruthy()

    // Go to Used
    fireEvent.click(screen.getAllByText(/used/i)[0])
    expect(await screen.findByText(/Used Devices List/i)).toBeTruthy()
  })
})
