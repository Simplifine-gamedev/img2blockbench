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

type Lane3Artifact = "threejs" | "bbmodel";

const phases = [
  "Reading reference",
  "Tracing anatomy",
  "Building cuboids",
  "Ready to inspect",
] as const;

export function DemoShell({
  initialAnimal,
}: {
  initialAnimal: AnimalSlug;
}) {
  const [animalSlug, setAnimalSlug] = useState<AnimalSlug>(initialAnimal);
  const [laneSlug, setLaneSlug] = useState<LaneSlug>("lane2");
  const [phase, setPhase] = useState(phases.length - 1);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const [isReplaying, setIsReplaying] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [captureMode, setCaptureMode] = useState(false);
  const [lane3Artifact, setLane3Artifact] =
    useState<Lane3Artifact>("bbmodel");
  const animal = animals[animalSlug];
  const lane = lanes[laneSlug];
  const model = animal.models[laneSlug] ?? animal.models.lane2!;
  const showingLane3Source =
    laneSlug === "lane3" &&
    lane3Artifact === "threejs" &&
    Boolean(model.threeSceneFile);
  const viewerFile = showingLane3Source
    ? model.threeSceneFile!
    : model.modelFile;
  const isReady = phase === phases.length - 1 && modelLoaded;

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
      const requestedArtifact = searchParams.get("view");
      if (requestedArtifact === "bbmodel" || requestedArtifact === "threejs") {
        setLane3Artifact(requestedArtifact);
      }
      setCaptureMode(searchParams.get("capture") === "1");
    }, 0);

    return () => window.clearTimeout(syncUrlState);
  }, [initialAnimal]);

  useEffect(() => {
    if (!isReplaying) return;

    const timers = [
      window.setTimeout(() => setPhase(1), 420),
      window.setTimeout(() => setPhase(2), 840),
      window.setTimeout(() => {
        setPhase(3);
        setIsReplaying(false);
      }, 1_260),
    ];

    return () => timers.forEach(window.clearTimeout);
  }, [isReplaying, replayKey]);

  const startReplay = useCallback(() => {
    setPhase(0);
    setIsReplaying(true);
    setReplayKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        startReplay();
      }

      if (event.key.toLowerCase() === "f") {
        setFocusMode((value) => !value);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startReplay]);

  const prefetchAnimal = useCallback((slug: AnimalSlug) => {
    const target = animals[slug];
    Object.values(target.models).forEach((targetModel) => {
      if (targetModel) {
        prefetchModel(targetModel.modelFile);
        if (targetModel.threeSceneFile) {
          prefetchModel(targetModel.threeSceneFile);
        }
      }
    });

    const reference = new Image();
    reference.src = `/references/${slug}.png`;
  }, []);

  useEffect(() => {
    prefetchAnimal(animalSlug);
  }, [animalSlug, prefetchAnimal]);

  const statusText = useMemo(
    () => (modelLoaded ? phases[phase] : "Switching model"),
    [modelLoaded, phase],
  );
  const handleModelLoaded = useCallback(() => setModelLoaded(true), []);
  const prepareInstantSwitch = () => {
    setModelLoaded(false);
    setPhase(phases.length - 1);
    setIsReplaying(false);
  };
  const handleAnimalChange = (nextAnimal: AnimalSlug) => {
    if (nextAnimal === animalSlug) return;
    prepareInstantSwitch();
    setAnimalSlug(nextAnimal);
    const url = new URL(window.location.href);
    url.pathname = `/${nextAnimal}`;
    window.history.replaceState({}, "", url);
  };
  const handleLaneChange = (nextLane: LaneSlug) => {
    if (!animal.models[nextLane] || nextLane === laneSlug) return;
    prepareInstantSwitch();
    prefetchModel(animal.models[nextLane]!.modelFile);
    setLaneSlug(nextLane);
    const url = new URL(window.location.href);
    url.searchParams.set("lane", nextLane);
    if (nextLane === "lane3") {
      setLane3Artifact("bbmodel");
      url.searchParams.set("view", "bbmodel");
    } else {
      url.searchParams.delete("view");
    }
    window.history.replaceState({}, "", url);
  };
  const handleLane3ArtifactChange = (artifact: Lane3Artifact) => {
    if (artifact === lane3Artifact) return;
    prepareInstantSwitch();
    setLane3Artifact(artifact);
    const url = new URL(window.location.href);
    url.searchParams.set("view", artifact);
    window.history.replaceState({}, "", url);
  };

  return (
    <main
      className={`demo-shell${focusMode ? " focus-mode" : ""}${captureMode ? " capture-mode" : ""}`}
      style={
        {
          "--animal-accent": animal.accent,
          "--animal-accent-soft": animal.accentSoft,
        } as React.CSSProperties
      }
    >
      <aside className="source-panel" aria-label="Reference and model details">
        <header className="brand-row">
          <button
            className="brand"
            type="button"
            onClick={() => handleAnimalChange("platypus")}
            aria-label="img2blockbench home"
          >
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>img2blockbench</span>
          </button>
          <span className="version-pill">LANE {lane.number}</span>
        </header>

        <nav className="animal-tabs" aria-label="Choose an animal">
          {animalOrder.map((slug, index) => (
            <button
              key={slug}
              type="button"
              className={slug === animalSlug ? "active" : ""}
              aria-current={slug === animalSlug ? "page" : undefined}
              title={`${index + 1}. ${animals[slug].name}`}
              onPointerEnter={() => prefetchAnimal(slug)}
              onFocus={() => prefetchAnimal(slug)}
              onClick={() => handleAnimalChange(slug)}
            >
              {animals[slug].name}
            </button>
          ))}
        </nav>

        <section className="lane-benchmark" aria-label="Compare generation lanes">
          <div className="section-kicker">
            <span>Benchmark lanes</span>
            <span>Same reference</span>
          </div>
          <div className="lane-tabs">
            {laneOrder.map((slug) => {
              const option = lanes[slug];
              const available = Boolean(animal.models[slug]);
              return (
                <button
                  key={slug}
                  type="button"
                  className={slug === laneSlug ? "active" : ""}
                  disabled={!available}
                  aria-pressed={slug === laneSlug}
                  title={
                    available
                      ? `${option.name} pipeline`
                      : `${option.name} is currently benchmarked on the platypus`
                  }
                  onClick={() => handleLaneChange(slug)}
                >
                  <b>{option.number}</b>
                  <span>{option.name}</span>
                </button>
              );
            })}
          </div>
          <div className="lane-facts">
            <span><b>GPU</b>{lane.gpu}</span>
            <span><b>INTERMEDIATE</b>{lane.intermediate}</span>
          </div>
        </section>

        <section className="reference-section">
          <div className="section-kicker">
            <span>Source reference</span>
            <span>01 / 01</span>
          </div>
          <div className="reference-frame">
            {/* Native img avoids transformed asset paths in exported builds. */}
            <img
              src={`/references/${animal.slug}.png`}
              alt={`Minecraft-style ${animal.name} reference`}
            />
            <span className="image-corner top-left" />
            <span className="image-corner top-right" />
            <span className="image-corner bottom-left" />
            <span className="image-corner bottom-right" />
          </div>
        </section>

        <section className="prompt-card">
          <span className="prompt-label">RECONSTRUCTION BRIEF</span>
          <p>{animal.prompt}</p>
        </section>

        <section className="pipeline-card" aria-label="Generation progress">
          <div className="pipeline-heading">
            <span>{statusText}</span>
            <span>{isReady ? "100%" : `${Math.max(18, phase * 31)}%`}</span>
          </div>
          <div className="progress-track">
            <i style={{ width: isReady ? "100%" : `${22 + phase * 25}%` }} />
          </div>
          <ol>
            {lane.stages.map((stage, index) => (
              <li key={stage.label} className={phase >= index ? "complete" : ""}>
                <span>{stage.label}</span>
                <b>{index === 2 ? `${model.cuboids} CUBOIDS` : stage.value}</b>
              </li>
            ))}
          </ol>
        </section>

        <div className="sidebar-actions">
          <button
            className="primary-button"
            type="button"
            onClick={startReplay}
          >
            <span className="replay-icon" aria-hidden="true">↻</span>
            Replay build
          </button>
          <a
            className="icon-button"
            href={`/models/${viewerFile}`}
            download
            aria-label={`Download ${animal.name} ${
              showingLane3Source ? "Three.js scene" : "Blockbench model"
            }`}
            title={showingLane3Source ? "Download Three.js scene JSON" : "Download .bbmodel"}
          >
            ↓
          </a>
        </div>

        <footer className="source-footer">
          <a
            href="https://github.com/orca-gamedev/img2blockbench"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <span>Open source · MIT</span>
        </footer>
      </aside>

      <section className="viewer-panel" aria-label={`${animal.name} 3D model`}>
        <div className="viewer-topbar">
          <div>
            <span className="eyebrow">
              {showingLane3Source
                ? "THREE.JS INTERMEDIATE"
                : laneSlug === "lane3"
                  ? "FINAL BLOCKBENCH OUTPUT"
                  : lane.eyebrow}
            </span>
            <h1>{animal.name}</h1>
          </div>
          <div className="viewer-controls">
            {laneSlug === "lane3" && model.threeSceneFile && (
              <div className="artifact-toggle" aria-label="Choose Lane 3 artifact">
                <button
                  type="button"
                  className={lane3Artifact === "threejs" ? "active" : ""}
                  aria-pressed={lane3Artifact === "threejs"}
                  onClick={() => handleLane3ArtifactChange("threejs")}
                >
                  <b>1</b>
                  THREE.JS INTERMEDIATE
                </button>
                <span aria-hidden="true">→</span>
                <button
                  type="button"
                  className={lane3Artifact === "bbmodel" ? "active" : ""}
                  aria-pressed={lane3Artifact === "bbmodel"}
                  onClick={() => handleLane3ArtifactChange("bbmodel")}
                >
                  <b>2</b>
                  BBMODEL OUTPUT
                </button>
              </div>
            )}
            <div className={`model-status${isReady ? " ready" : ""}`}>
              <i />
              {isReady ? "MODEL READY" : statusText.toUpperCase()}
            </div>
          </div>
        </div>

        <div className="viewer-stage">
          <ModelViewer
            animal={animal}
            modelFile={viewerFile}
            format={showingLane3Source ? "threejs" : "bbmodel"}
            ready={isReady}
            replayKey={replayKey}
            captureMode={captureMode}
            onLoaded={handleModelLoaded}
          />

          {!isReady && (
            <div className="build-overlay" aria-live="polite">
              <div className="scan-reticle">
                <i className="reticle-corner r1" />
                <i className="reticle-corner r2" />
                <i className="reticle-corner r3" />
                <i className="reticle-corner r4" />
                <span />
              </div>
              <p>{statusText}</p>
              <small>{lane.pipeline}</small>
            </div>
          )}
        </div>

        <div className="viewer-footer">
          <div className="model-metrics">
            {showingLane3Source ? (
              <>
                <span>
                  <b>{model.sceneNodes}</b>
                  BOX NODES
                </span>
                <span>
                  <b>{model.sceneMaterials}</b>
                  PBR MATERIALS
                </span>
                <span>
                  <b>{model.sceneSize}</b>
                  SCENE JSON
                </span>
              </>
            ) : laneSlug === "lane3" && model.sourceMaps ? (
              <>
                <span>
                  <b>{model.cuboids}</b>
                  CUBOIDS
                </span>
                <span>
                  <b>{model.sourceMaps}</b>
                  SOURCE MAPS
                </span>
                <span>
                  <b>{model.texture}</b>
                  BAKED ATLAS
                </span>
              </>
            ) : (
              <>
                <span>
                  <b>{model.cuboids}</b>
                  CUBOIDS
                </span>
                <span>
                  <b>{model.groups}</b>
                  BONE GROUPS
                </span>
                <span>
                  <b>{model.texture}</b>
                  TEXTURE
                </span>
              </>
            )}
          </div>
          <div className="keyboard-hints">
            <span><kbd>DRAG</kbd> ORBIT</span>
            <span><kbd>SCROLL</kbd> ZOOM</span>
            <span><kbd>SPACE</kbd> REPLAY</span>
            <button type="button" onClick={() => setFocusMode((value) => !value)}>
              <kbd>F</kbd> {focusMode ? "SHOW UI" : "FOCUS"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
