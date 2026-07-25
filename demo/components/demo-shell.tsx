"use client";

import { useCallback, useEffect, useState } from "react";
import { ModelViewer, prefetchModel } from "@/components/model-viewer";
import {
  animalOrder,
  animals,
  isLaneSlug,
  laneOrder,
  lanes,
  type AnimalSlug,
  type LaneSlug,
} from "@/lib/animals";

export function DemoShell({
  initialAnimal,
}: {
  initialAnimal: AnimalSlug;
}) {
  const [animalSlug, setAnimalSlug] = useState<AnimalSlug>(initialAnimal);
  const [laneSlug, setLaneSlug] = useState<LaneSlug>("lane2");
  const [modelLoaded, setModelLoaded] = useState(false);
  const [captureMode, setCaptureMode] = useState(false);
  const animal = animals[animalSlug];
  const lane = lanes[laneSlug];
  const model = animal.models[laneSlug] ?? animal.models.lane2!;

  useEffect(() => {
    const syncUrlState = window.setTimeout(() => {
      const searchParams = new URLSearchParams(window.location.search);
      const requestedLane = searchParams.get("lane");
      if (
        requestedLane &&
        isLaneSlug(requestedLane) &&
        animals[initialAnimal].models[requestedLane]
      ) {
        setLaneSlug(requestedLane);
      }
      setCaptureMode(searchParams.get("capture") === "1");
    }, 0);

    return () => window.clearTimeout(syncUrlState);
  }, [initialAnimal]);

  const prefetchAnimal = useCallback((slug: AnimalSlug) => {
    const target = animals[slug];
    Object.values(target.models).forEach((targetModel) => {
      if (targetModel) prefetchModel(targetModel.modelFile);
    });

    const reference = new Image();
    reference.src = `/references/${slug}.png`;
  }, []);

  useEffect(() => {
    prefetchAnimal(animalSlug);
    const warmCache = window.setTimeout(() => {
      animalOrder.forEach(prefetchAnimal);
    }, 250);

    return () => window.clearTimeout(warmCache);
  }, [animalSlug, prefetchAnimal]);

  const handleModelLoaded = useCallback(() => setModelLoaded(true), []);
  const prepareSwitch = () => setModelLoaded(false);

  const handleAnimalChange = (nextAnimal: AnimalSlug) => {
    if (nextAnimal === animalSlug) return;
    prepareSwitch();
    setAnimalSlug(nextAnimal);
    const url = new URL(window.location.href);
    url.pathname = `/${nextAnimal}`;
    window.history.replaceState({}, "", url);
  };

  const handleLaneChange = (nextLane: LaneSlug) => {
    if (!animal.models[nextLane] || nextLane === laneSlug) return;
    prepareSwitch();
    prefetchModel(animal.models[nextLane]!.modelFile);
    setLaneSlug(nextLane);
    const url = new URL(window.location.href);
    url.searchParams.set("lane", nextLane);
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
  };

  return (
    <main
      className={`compact-demo${captureMode ? " capture-mode" : ""}`}
      style={
        {
          "--animal-accent": animal.accent,
          "--animal-accent-soft": animal.accentSoft,
        } as React.CSSProperties
      }
    >
      <section className="compact-viewer" aria-label={`${animal.name} 3D model`}>
        <ModelViewer
          animal={animal}
          modelFile={model.modelFile}
          format="bbmodel"
          ready={modelLoaded}
          captureMode={captureMode}
          onLoaded={handleModelLoaded}
        />
      </section>

      {!captureMode && (
        <>
          <header className="compact-title">
            <span>img2blockbench</span>
            <h1>Image → Minecraft Model</h1>
          </header>

          <aside className="pair-card" aria-label="Choose reference and output">
            <div className="pair-card-heading">
              <div>
                <span>REFERENCE / MODEL PAIR</span>
                <strong>{animal.name}</strong>
              </div>
              <i className={modelLoaded ? "ready" : ""} aria-hidden="true" />
            </div>

            <div className="pair-selectors">
              <label>
                <span>Animal</span>
                <select
                  value={animalSlug}
                  onChange={(event) =>
                    handleAnimalChange(event.target.value as AnimalSlug)
                  }
                >
                  {animalOrder.map((slug) => (
                    <option key={slug} value={slug}>
                      {animals[slug].name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Pipeline</span>
                <select
                  value={laneSlug}
                  onChange={(event) =>
                    handleLaneChange(event.target.value as LaneSlug)
                  }
                >
                  {laneOrder.map((slug) => (
                    <option
                      key={slug}
                      value={slug}
                      disabled={!animal.models[slug]}
                    >
                      Lane {lanes[slug].number} · {lanes[slug].name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="pair-reference">
              {/* Native img preserves static exported asset paths. */}
              <img
                src={`/references/${animal.slug}.png`}
                alt={`Minecraft-style ${animal.name} reference`}
              />
              <span>INPUT IMAGE</span>
            </div>

            <div className="pair-output">
              <div>
                <span>{lane.pipeline}</span>
                <b>{model.cuboids} cuboids · {model.texture} texture</b>
              </div>
              <small aria-live="polite">
                {modelLoaded ? "MODEL READY" : "SWITCHING…"}
              </small>
            </div>
          </aside>
        </>
      )}
    </main>
  );
}
