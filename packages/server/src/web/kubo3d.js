// KUBO en three.js: lo usan la vista 3D del cuarto y la de los lentes. Las piezas del modelo se prenden
// o apagan según el avatar, y los colores salen de la misma tabla que la vista 2D.
import { AnimationMixer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export const seed = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const HAIR = { black:"#2e2b3f", brown:"#7a4b33", blonde:"#efc777", red:"#c4563c", pink:"#f39aae", blue:"#6f8fe0", green:"#5fae8f", purple:"#9c7ad6", white:"#efe6dc" };
export const CLOTH = ["#7b5cff", "#8eb8ff", "#bfa7ff", "#b7f3d9", "#ffb4a3"];

export const loadKubo = () => new Promise((ok, fail) => new GLTFLoader().load("/assets/kubo.glb", ok, undefined, fail));

function tint(root, name, hex) {
  const fix = (m) => { if (m.name !== name) return m; const c = m.clone(); c.color.set(hex); return c; };
  root.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material); });
}

/** Color de la ropa del agente: el de su avatar o uno fijo según su id. */
export const clothOf = (p) => /^#[0-9a-f]{6}$/i.test((p.avatar || {}).palette || "") ? p.avatar.palette : CLOTH[seed(p.participant_id) % CLOTH.length];

/** Un KUBO vestido según el avatar, a escala 1.5 y sin colocar. `key` cambia cuando cambia el avatar. */
export function makeAgent(kubo, p) {
  const a = p.avatar || {}, root = cloneSkinned(kubo.scene);
  const show = { body: "body_" + (a.outfit || "hoodie"), accessory: "accessory_" + (a.accessory || "none"), pet: "pet_" + (a.pet || "none") };
  root.traverse((o) => {
    // Solo el nodo de la variante; sus hijos por material se llaman body_hoodie_1, body_hoodie_2, ...
    const group = (/^(body|accessory|pet)_[a-z]+$/.exec(o.name) || [])[1];
    // En el modelo las variantes vienen con escala 0: se prende la que toca.
    if (group) { const on = o.name === show[group]; o.visible = on; if (on) o.scale.set(1, 1, 1); }
  });
  tint(root, "Body Tint", clothOf(p));
  tint(root, "Hair Tint", HAIR[a.hair] || HAIR.purple);
  root.scale.setScalar(1.5);
  const mixer = new AnimationMixer(root), actions = {};
  for (const clip of kubo.animations) actions[clip.name] = mixer.clipAction(clip);
  return { root, mixer, actions, state: "", key: JSON.stringify(a) };
}

/** Pasa a otra animación con un fundido corto. Si el modelo no la tiene, sigue con la actual. */
export function play(ag, name) {
  if (ag.state === name || !ag.actions[name]) return;
  ag.actions[name].reset().fadeIn(0.3).play();
  if (ag.state && ag.actions[ag.state]) ag.actions[ag.state].fadeOut(0.3);
  ag.state = name;
}
