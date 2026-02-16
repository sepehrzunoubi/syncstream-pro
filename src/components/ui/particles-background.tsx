"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import Particles, { initParticlesEngine } from "@tsparticles/react";
import { type ISourceOptions } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";

let engineReady = false;
let enginePromise: Promise<void> | null = null;

function ensureEngine(): Promise<void> {
  if (engineReady) return Promise.resolve();
  if (!enginePromise) {
    enginePromise = initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    }).then(() => {
      engineReady = true;
    }).catch((err) => {
      console.error("Particles engine init failed:", err);
      enginePromise = null;
    });
  }
  return enginePromise;
}

export const ParticlesBackground = React.memo(function ParticlesBackground() {
  const [init, setInit] = useState(engineReady);
  const uniqueId = useId();

  useEffect(() => {
    if (engineReady) {
      setInit(true);
      return;
    }
    ensureEngine().then(() => setInit(true)).catch(() => {});
  }, []);

  const options: ISourceOptions = useMemo(
    () => ({
      background: {
        color: {
          value: "transparent",
        },
      },
      fpsLimit: 30,
      interactivity: {
        events: {
          onClick: {
            enable: false,
          },
          onHover: {
            enable: false,
          },
        },
      },
      particles: {
        color: {
          value: "#ffffff",
        },
        move: {
          direction: "bottom",
          enable: true,
          outModes: {
            default: "out",
          },
          random: false,
          speed: 2.5,
          straight: true,
        },
        number: {
          density: {
            enable: true,
            area: 1000,
          },
          value: 60,
        },
        opacity: {
          value: { min: 0.15, max: 0.5 },
        },
        shape: {
          type: "circle",
        },
        size: {
          value: { min: 1, max: 2.5 },
        },
        wobble: {
          distance: 6,
          enable: true,
          speed: {
            min: -3,
            max: 3,
          },
        },
      },
      detectRetina: true,
    }),
    []
  );

  if (!init) {
    return null;
  }

  return (
    <Particles
      id={`tsparticles-${uniqueId}`}
      options={options}
      className="absolute inset-0 z-0 pointer-events-none"
    />
  );
});
