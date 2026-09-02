"use client"

import { Canvas } from "@react-three/fiber"
import { ParticleSphere } from "@/components/particle-sphere"

/**
 * Ambient backdrop for the courtroom -- the original particle sphere, dimmed
 * and pushed behind the UI.
 *
 * Deliberately non-interactive: no OrbitControls, and pointer-events are off at
 * the wrapper so the sphere never swallows clicks meant for the panels. A
 * gradient scrim on top keeps text contrast well clear of the imagery.
 */
export function CourtBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div className="absolute inset-0 opacity-70">
        <Canvas camera={{ position: [-10, 1.5, 10], fov: 50 }} frameloop="always">
          <ambientLight intensity={0.5} />
          <pointLight position={[10, 10, 10]} intensity={1} />
          <ParticleSphere />
        </Canvas>
      </div>

      {/* Scrim: keeps the panels legible over whatever drifts past. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-black/85" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_10%,rgba(0,0,0,0.6)_80%)]" />
    </div>
  )
}
