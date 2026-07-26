"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [captureMode, setCaptureMode] = useState(false);
  const [captureLane, setCaptureLane] = useState<LaneSlug>("lane2");
  const animal = animals[animalSlug];

  useEffect(() => {
    const syncUrlState = window.setTimeout(() => {
      const searchParams = new URLSearchParams(window.location.search);
      const requestedLane = searchParams.get("lane");
      setCaptureMode(searchParams.get("capture") === "1");
      if (requestedLane && isLaneSlug(requestedLane)) {
        setCaptureLane(requestedLane);
      }
    }, 0);

    return () => window.clearTimeout(syncUrlState);
  }, []);

  const prefetchAnimal = useCallback((slug: AnimalSlug) => {
    const target = animals[slug];
    laneOrder.forEach((laneSlug) => {
      const targetModel = target.models[laneSlug];
      if (targetModel) prefetchModel(targetModel.modelFile);
    });

    const reference = new Image();
    reference.decoding = "async";
    reference.src = `/references/${slug}.png`;
  }, []);

  useEffect(() => {
    animalOrder.forEach(prefetchAnimal);
  }, [prefetchAnimal]);

  const handleAnimalChange = (nextAnimal: AnimalSlug) => {
    if (nextAnimal === animalSlug) return;
    setAnimalSlug(nextAnimal);
    const url = new URL(window.location.href);
    url.pathname = `/${nextAnimal}`;
    window.history.replaceState({}, "", url);
  };

  const captureModel = useMemo(
    () => animal.models[captureLane] ?? animal.models.lane2!,
    [animal, captureLane],
  );

  if (captureMode) {
    return (
      <main className="capture-mode">
        <ModelViewer
          animal={animal}
          modelFile={captureModel.modelFile}
          format="bbmodel"
          captureMode
        />
      </main>
    );
  }

  return (
    <main
      className="benchmark-demo"
      style={
        {
          "--animal-accent": animal.accent,
          "--animal-accent-soft": animal.accentSoft,
        } as React.CSSProperties
      }
    >
      <aside className="animal-rail" aria-label="Choose an animal">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong>img2blockbench</strong>
            <small>THREE-LANE BENCHMARK</small>
          </div>
        </header>

        <nav className="animal-list">
          {animalOrder.map((slug) => {
            const option = animals[slug];
            const selected = slug === animalSlug;
            return (
              <button
                key={slug}
                type="button"
                className={`animal-option${selected ? " selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => handleAnimalChange(slug)}
              >
                <img
                  src={`/references/${slug}.png`}
                  alt=""
                  width={160}
                  height={112}
                />
                <span>{option.name}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="comparison-stage" aria-label={`${animal.name} models`}>
        <header className="comparison-heading">
          <div>
            <span>SAME IMAGE · THREE ROUTES · BBMODEL OUTPUT</span>
            <h1>{animal.name}</h1>
          </div>
          <p>
            <b>DRAG</b> rotate <i /> <b>WHEEL</b> zoom
          </p>
        </header>

        <div className="lane-grid">
          {laneOrder.map((laneSlug) => {
            const lane = lanes[laneSlug];
            const model = animal.models[laneSlug]!;
            return (
              <article
                className="lane-view"
                key={laneSlug}
                aria-label={`${lane.name} ${animal.name} model`}
              >
                <header className="lane-label">
                  <div>
                    <span>{lane.number}</span>
                    <strong>{lane.name}</strong>
                  </div>
                  <small>{model.cuboids} CUBOIDS</small>
                </header>
                <ModelViewer
                  animal={animal}
                  modelFile={model.modelFile}
                  format="bbmodel"
                  captureMode={false}
                  showHint={false}
                />
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
