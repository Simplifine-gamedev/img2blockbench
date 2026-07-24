"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelViewer } from "@/components/model-viewer";
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
  const animal = animals[initialAnimal];
  const [laneSlug, setLaneSlug] = useState<LaneSlug>("lane2");
  const [phase, setPhase] = useState(0);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [captureMode, setCaptureMode] = useState(false);
  const [lane3Artifact, setLane3Artifact] =
    useState<Lane3Artifact>("bbmodel");
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
    const searchParams = new URLSearchParams(window.location.search);
    const requestedLane = searchParams.get("lane");
    if (
      requestedLane &&
      isLaneSlug(requestedLane) &&
      animal.models[requestedLane]
    ) {
      setLaneSlug(requestedLane);
    }
    const requestedArtifact = searchParams.get("view");
    if (requestedArtifact === "bbmodel" || requestedArtifact === "threejs") {
      setLane3Artifact(requestedArtifact);
    }
    setCaptureMode(searchParams.get("capture") === "1");
  }, [animal]);

  useEffect(() => {
    if (!animal.models[laneSlug]) {
      setLaneSlug("lane2");
    }
  }, [animal, laneSlug]);

  useEffect(() => {
    setModelLoaded(false);
    setPhase(0);

    const timers = [
      window.setTimeout(() => setPhase(1), 720),
      window.setTimeout(() => setPhase(2), 1_480),
      window.setTimeout(() => setPhase(3), 2_300),
    ];

    return () => timers.forEach(window.clearTimeout);
  }, [initialAnimal, laneSlug, lane3Artifact, replayKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setReplayKey((value) => value + 1);
      }

      if (event.key.toLowerCase() === "f") {
        setFocusMode((value) => !value);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const statusText = useMemo(
    () => (modelLoaded ? phases[phase] : "Loading model"),
    [modelLoaded, phase],
  );
  const handleModelLoaded = useCallback(() => setModelLoaded(true), []);
  const handleLaneChange = (nextLane: LaneSlug) => {
    if (!animal.models[nextLane] || nextLane === laneSlug) return;
    setLaneSlug(nextLane);
    setReplayKey((value) => value + 1);
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
    setLane3Artifact(artifact);
    setReplayKey((value) => value + 1);
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
          <a className="brand" href="/" aria-label="img2blockbench home">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>img2blockbench</span>
          </a>
          <span className="version-pill">LANE {lane.number}</span>
        </header>

        <nav className="animal-tabs" aria-label="Choose an animal">
          {animalOrder.map((slug, index) => (
            <a
              key={slug}
              href={`/${slug}`}
              className={slug === initialAnimal ? "active" : ""}
              aria-current={slug === initialAnimal ? "page" : undefined}
              title={`${index + 1}. ${animals[slug].name}`}
            >
              {animals[slug].name}
            </a>
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
            onClick={() => setReplayKey((value) => value + 1)}
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
