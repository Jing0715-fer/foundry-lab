"use client";

import * as React from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parsePdb, type PdbStructure } from "@/lib/pdb-parser";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCw, Maximize, Atom, Circle, Cylinder } from "lucide-react";
import { cn } from "@/lib/utils";

type RepMode = "cartoon" | "ballstick" | "sphere";

const CHAIN_COLORS = [
  "#14b8a6",
  "#8b5cf6",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
];

const ELEMENT_COLORS: Record<string, string> = {
  C: "#909090",
  N: "#3050f8",
  O: "#ff0d0d",
  S: "#ffff30",
  P: "#ff8000",
  H: "#ffffff",
  FE: "#e06633",
  ZN: "#7d80b0",
  CA: "#3dff00",
  MG: "#8aff00",
};

export interface Pdb3DViewerProps {
  pdbText: string | null;
  className?: string;
}

/**
 * Three.js-based 3D molecular viewer. Renders a PDB structure in one of
 * three representation modes:
 *  - "cartoon":    backbone tube (spheres at CA + cylinders between CAs), colored per chain
 *  - "ballstick":  spheres for every atom + cylinders for backbone bonds, CPK colors
 *  - "sphere":     space-filling (van der Waals) spheres, CPK colors
 *
 * Mouse controls: orbit (left-drag), zoom (wheel), pan (right-drag).
 * Toolbar: representation switcher, auto-rotate toggle, reset view.
 */
export function Pdb3DViewer({ pdbText, className }: Pdb3DViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rendererRef = React.useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = React.useRef<THREE.Scene | null>(null);
  const cameraRef = React.useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = React.useRef<OrbitControls | null>(null);
  const frameRef = React.useRef<number>(0);
  const structureRef = React.useRef<PdbStructure | null>(null);
  const repGroupRef = React.useRef<THREE.Group | null>(null);
  // Mirror `autoRotate` into a ref so the rAF closure (which captures the
  // initial value) can read the latest state on every frame.
  const autoRotateRef = React.useRef(false);

  const [repMode, setRepMode] = React.useState<RepMode>("cartoon");
  const [autoRotate, setAutoRotate] = React.useState(false);
  const [stats, setStats] = React.useState<{
    atoms: number;
    chains: number;
    residues: number;
  } | null>(null);

  React.useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  // Parse PDB into a structure (kept in a ref so the render-effect can read it
  // synchronously without adding it to its dependency array).
  React.useEffect(() => {
    if (!pdbText) {
      structureRef.current = null;
      setStats(null);
      return;
    }
    try {
      const struct = parsePdb(pdbText);
      structureRef.current = struct;
      setStats({
        atoms: struct.atoms.length,
        chains: struct.chains.length,
        residues: struct.residueCount,
      });
    } catch {
      structureRef.current = null;
      setStats(null);
    }
  }, [pdbText]);

  // Initialize three.js scene + renderer + camera + controls. Runs once.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 0, 60);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 15);
    scene.add(dir);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      if (autoRotateRef.current && repGroupRef.current) {
        repGroupRef.current.rotation.y += 0.005;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Container-aware resize (catches dialog open/close + tab switches that
    // don't fire a window resize event).
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    const onWindowResize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // (Re)build the molecular representation whenever the structure or the
  // representation mode changes.
  React.useEffect(() => {
    const scene = sceneRef.current;
    const struct = structureRef.current;
    if (!scene || !struct) return;

    // Dispose previous representation.
    if (repGroupRef.current) {
      scene.remove(repGroupRef.current);
      repGroupRef.current.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material?.dispose();
        }
      });
      repGroupRef.current = null;
    }

    if (struct.atoms.length === 0) return;

    const group = new THREE.Group();
    repGroupRef.current = group;

    // Compute the structure's centroid and place every mesh relative to it,
    // so the group's local origin coincides with the centroid — this makes
    // auto-rotation spin around the structure's center (not the world origin).
    const center = new THREE.Vector3();
    struct.atoms.forEach((a) => center.add(new THREE.Vector3(a.x, a.y, a.z)));
    center.divideScalar(struct.atoms.length);

    const rel = (a: { x: number; y: number; z: number }) =>
      new THREE.Vector3(a.x - center.x, a.y - center.y, a.z - center.z);

    if (repMode === "cartoon") {
      // Backbone tube: for each chain, spheres at CA positions + cylinders
      // between consecutive CAs.
      const caByChain = new Map<string, THREE.Vector3[]>();
      struct.atoms.forEach((a) => {
        if (a.name === "CA") {
          const arr = caByChain.get(a.chainId) ?? [];
          arr.push(rel(a));
          caByChain.set(a.chainId, arr);
        }
      });
      for (const [chainId, cas] of caByChain) {
        if (cas.length < 2) continue;
        const colorIdx = struct.chains.indexOf(chainId) % CHAIN_COLORS.length;
        const color = new THREE.Color(CHAIN_COLORS[colorIdx]);
        for (let i = 0; i < cas.length; i++) {
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.8, 16, 16),
            new THREE.MeshPhongMaterial({ color }),
          );
          sphere.position.copy(cas[i]);
          group.add(sphere);
          if (i < cas.length - 1) {
            const mid = cas[i].clone().add(cas[i + 1]).multiplyScalar(0.5);
            const dir = cas[i + 1].clone().sub(cas[i]);
            const len = dir.length();
            const cyl = new THREE.Mesh(
              new THREE.CylinderGeometry(0.3, 0.3, len, 8),
              new THREE.MeshPhongMaterial({ color }),
            );
            cyl.position.copy(mid);
            cyl.lookAt(cas[i + 1]);
            cyl.rotateX(Math.PI / 2);
            group.add(cyl);
          }
        }
      }
    } else if (repMode === "ballstick") {
      // Ball-and-stick: spheres for atoms + cylinders for backbone bonds.
      for (const atom of struct.atoms) {
        const color = ELEMENT_COLORS[atom.element] ?? "#909090";
        const radius = atom.element === "C" ? 0.4 : 0.5;
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 12, 12),
          new THREE.MeshPhongMaterial({ color: new THREE.Color(color) }),
        );
        sphere.position.copy(rel(atom));
        group.add(sphere);
      }
      for (const [a, b] of struct.backboneBonds) {
        const posA = rel(struct.atoms[a]);
        const posB = rel(struct.atoms[b]);
        const mid = posA.clone().add(posB).multiplyScalar(0.5);
        const dir = posB.clone().sub(posA);
        const len = dir.length();
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.15, len, 6),
          new THREE.MeshPhongMaterial({ color: 0xaaaaaa }),
        );
        cyl.position.copy(mid);
        cyl.lookAt(posB);
        cyl.rotateX(Math.PI / 2);
        group.add(cyl);
      }
    } else if (repMode === "sphere") {
      // Space-filling (van der Waals) spheres.
      for (const atom of struct.atoms) {
        const color = ELEMENT_COLORS[atom.element] ?? "#909090";
        const radius = 1.6;
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 16, 16),
          new THREE.MeshPhongMaterial({ color: new THREE.Color(color) }),
        );
        sphere.position.copy(rel(atom));
        group.add(sphere);
      }
    }

    scene.add(group);

    // Auto-fit camera so the whole structure is in view.
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (camera && controls) {
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const fov = camera.fov * (Math.PI / 180);
      const dist = ((maxDim / 2) / Math.tan(fov / 2)) * 1.5;
      camera.position.set(0, 0, dist);
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [repMode, pdbText]);

  const resetView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const group = repGroupRef.current;
    if (!camera || !controls || !group) return;
    // Reset accumulated auto-rotation too.
    group.rotation.set(0, 0, 0);
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = camera.fov * (Math.PI / 180);
    const dist = ((maxDim / 2) / Math.tan(fov / 2)) * 1.5;
    camera.position.set(0, 0, dist);
    controls.target.set(0, 0, 0);
    controls.update();
  };

  if (!pdbText) {
    return (
      <div className={cn("flex items-center justify-center", className)}>
        <div className="text-center text-muted-foreground">
          <Atom className="mx-auto mb-2 size-8 opacity-50" />
          <p className="text-sm">No structure to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex gap-1">
          {(["cartoon", "ballstick", "sphere"] as RepMode[]).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={repMode === mode ? "default" : "outline"}
              onClick={() => setRepMode(mode)}
              className="h-7 text-xs"
              type="button"
            >
              {mode === "cartoon" ? (
                <Cylinder className="size-3" />
              ) : mode === "ballstick" ? (
                <Atom className="size-3" />
              ) : (
                <Circle className="size-3" />
              )}
              {mode === "cartoon"
                ? "Cartoon"
                : mode === "ballstick"
                  ? "Ball-Stick"
                  : "Sphere"}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoRotate((v) => !v)}
            className="h-7"
            type="button"
            aria-label={autoRotate ? "Pause auto-rotate" : "Start auto-rotate"}
            title={autoRotate ? "Pause auto-rotate" : "Start auto-rotate"}
          >
            <RotateCw className={cn("size-3.5", autoRotate && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetView}
            className="h-7"
            type="button"
            aria-label="Reset view"
            title="Reset view"
          >
            <Maximize className="size-3.5" />
          </Button>
        </div>
      </div>
      {/* Stats */}
      {stats && (
        <div className="flex gap-2 border-b px-3 py-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {stats.atoms} atoms
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {stats.residues} residues
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {stats.chains} chains
          </Badge>
        </div>
      )}
      {/* 3D canvas */}
      <div
        ref={containerRef}
        className="min-h-[300px] flex-1"
        style={{ background: "#1a1a2e" }}
      />
    </div>
  );
}

export default Pdb3DViewer;
