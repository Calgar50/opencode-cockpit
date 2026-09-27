// Déclaration locale et minimale du module « three » 0.186.0 (itération 3, L32 ; plan it3 D-3d-04, décision Q2 (a)). three ne
// publie aucun type et @types/three n'est pas une dépendance permise (P8) : seules les classes et constantes de la salle de
// contrôle 3D sont déclarées, avec leurs seuls membres utilisés, sans `any`. three-exports.test.ts vérifie chaque classe et chaque
// constante contre le vrai module (valeurs comprises). Un paquet qui a besoin d'une déclaration de plus ajoute
// `three-<paquet>.d.ts` dans ce dossier : les déclarations d'un module ambiant fusionnent.
// Ce fichier reste un script (aucun import ni export de premier niveau) : sinon `declare module` deviendrait une augmentation.
// Les interfaces (paramètres, `Material`, `IUniform`…) sont des types seulement, sans valeur à l'exécution.
declare module "three" {
  export const REVISION: "186";

  export const NormalBlending: 1;
  export const AdditiveBlending: 2;
  export const DoubleSide: 2;
  export const RepeatWrapping: 1000;
  export const ClampToEdgeWrapping: 1001;
  export const LinearFilter: 1006;
  export const RGBAFormat: 1023;
  export const SRGBColorSpace: "srgb";

  /** Modes de mélange (NoBlending 0, NormalBlending 1, AdditiveBlending 2 … CustomBlending 5). */
  export type Blending = 0 | 1 | 2 | 3 | 4 | 5;
  /** Faces dessinées (FrontSide 0, BackSide 1, DoubleSide 2). */
  export type Side = 0 | 1 | 2;
  /** Répétition d'une texture (RepeatWrapping 1000, ClampToEdgeWrapping 1001, MirroredRepeatWrapping 1002). */
  export type Wrapping = 1000 | 1001 | 1002;
  /** Filtres d'une texture (NearestFilter 1003 … LinearFilter 1006 … LinearMipmapLinearFilter 1008). */
  export type TextureFilter = 1003 | 1004 | 1005 | 1006 | 1007 | 1008;
  /** Format des octets d'une DataTexture : RGBA seulement (textures générées, D-3d-17). */
  export type PixelFormat = typeof RGBAFormat;
  /** Espaces de couleurs (NoColorSpace, SRGBColorSpace, LinearSRGBColorSpace). */
  export type ColorSpace = "" | "srgb" | "srgb-linear";
  export type ColorRepresentation = Color | string | number;

  // --- Mathématiques ---------------------------------------------------------------------------------------------------------

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    clone(): Vector3;
    lerpVectors(v1: Vector3, v2: Vector3, alpha: number): this;
    /** Coordonnées normalisées de l'écran (−1 à 1) vues par la caméra : placement des étiquettes DOM. */
    project(camera: PerspectiveCamera): this;
  }

  /** Vecteur à deux composantes (`offset`, `repeat` d'une texture) ; la classe Vector2 n'est pas déclarée. */
  export interface Vector2Like {
    x: number;
    y: number;
    set(x: number, y: number): this;
  }

  export class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    setFromAxisAngle(axis: Vector3, angle: number): this;
  }

  export class Matrix4 {
    constructor();
    identity(): this;
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    makeTranslation(x: number, y: number, z: number): this;
  }

  export class Color {
    constructor(color?: ColorRepresentation);
    constructor(r: number, g: number, b: number);
    r: number;
    g: number;
    b: number;
    set(color: ColorRepresentation): this;
    setRGB(r: number, g: number, b: number): this;
    getHex(): number;
  }

  // --- Scène et objets ---------------------------------------------------------------------------------------------------------

  export class Object3D {
    name: string;
    visible: boolean;
    renderOrder: number;
    frustumCulled: boolean;
    readonly position: Vector3;
    readonly quaternion: Quaternion;
    readonly scale: Vector3;
    /** Données libres : `faits` recopiés du plan (P12). */
    userData: Record<string, unknown>;
    readonly children: Object3D[];
    parent: Object3D | null;
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
    clear(): this;
    lookAt(target: Vector3): void;
    lookAt(x: number, y: number, z: number): void;
    traverse(callback: (object: Object3D) => void): void;
    updateMatrixWorld(force?: boolean): void;
  }

  export class Scene extends Object3D {
    background: Color | Texture | null;
  }

  export class Group extends Object3D {}

  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    near: number;
    far: number;
    updateProjectionMatrix(): void;
  }

  export class Mesh<TGeometry extends BufferGeometry = BufferGeometry, TMaterial extends Material = Material> extends Object3D {
    constructor(geometry?: TGeometry, material?: TMaterial);
    geometry: TGeometry;
    material: TMaterial;
  }

  /** Tampon des matrices d'un InstancedMesh (InstancedBufferAttribute, non déclaré) : `needsUpdate` après `setMatrixAt`. */
  export interface InstanceBuffer {
    readonly count: number;
    set needsUpdate(value: boolean);
  }

  export class InstancedMesh<TGeometry extends BufferGeometry = BufferGeometry, TMaterial extends Material = Material> extends Mesh<
    TGeometry,
    TMaterial
  > {
    constructor(geometry: TGeometry | undefined, material: TMaterial | undefined, count: number);
    count: number;
    readonly instanceMatrix: InstanceBuffer;
    setMatrixAt(index: number, matrix: Matrix4): void;
    setColorAt(index: number, color: Color): void;
  }

  export class LineSegments<TGeometry extends BufferGeometry = BufferGeometry, TMaterial extends Material = LineBasicMaterial> extends Object3D {
    constructor(geometry?: TGeometry, material?: TMaterial);
    geometry: TGeometry;
    material: TMaterial;
  }

  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial);
    material: SpriteMaterial;
  }

  // --- Géométries --------------------------------------------------------------------------------------------------------------

  export class BufferGeometry {
    translate(x: number, y: number, z: number): this;
    rotateX(angle: number): this;
    rotateY(angle: number): this;
    dispose(): void;
  }

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
  }

  export class CylinderGeometry extends BufferGeometry {
    constructor(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number, heightSegments?: number, openEnded?: boolean);
  }

  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }

  export interface ExtrudeOptions {
    depth?: number;
    steps?: number;
    curveSegments?: number;
    bevelEnabled?: boolean;
  }

  export class ExtrudeGeometry extends BufferGeometry {
    constructor(shapes?: Shape | Shape[], options?: ExtrudeOptions);
  }

  export class EdgesGeometry extends BufferGeometry {
    constructor(geometry?: BufferGeometry | null, thresholdAngle?: number);
  }

  export class TubeGeometry extends BufferGeometry {
    constructor(path?: QuadraticBezierCurve3, tubularSegments?: number, radius?: number, radialSegments?: number, closed?: boolean);
  }

  export class Shape {
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    closePath(): this;
  }

  export class QuadraticBezierCurve3 {
    constructor(v0?: Vector3, v1?: Vector3, v2?: Vector3);
    v0: Vector3;
    v1: Vector3;
    v2: Vector3;
    getPoint(t: number, optionalTarget?: Vector3): Vector3;
  }

  // --- Matériaux et textures ---------------------------------------------------------------------------------------------------

  /** Paramètres communs des matériaux déclarés. */
  export interface MaterialParameters {
    transparent?: boolean;
    opacity?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    side?: Side;
    blending?: Blending;
  }

  /** Membres communs des matériaux déclarés (type seulement : la classe Material n'est pas déclarée). */
  export interface Material {
    transparent: boolean;
    opacity: number;
    depthTest: boolean;
    depthWrite: boolean;
    side: Side;
    blending: Blending;
    visible: boolean;
    set needsUpdate(value: boolean);
    dispose(): void;
  }

  export interface MeshBasicMaterialParameters extends MaterialParameters {
    color?: ColorRepresentation;
    map?: Texture | null;
  }
  export class MeshBasicMaterial {
    constructor(parameters?: MeshBasicMaterialParameters);
    color: Color;
    map: Texture | null;
  }
  export interface MeshBasicMaterial extends Material {}

  export interface LineBasicMaterialParameters extends MaterialParameters {
    color?: ColorRepresentation;
  }
  export class LineBasicMaterial {
    constructor(parameters?: LineBasicMaterialParameters);
    color: Color;
  }
  export interface LineBasicMaterial extends Material {}

  export interface SpriteMaterialParameters extends MaterialParameters {
    color?: ColorRepresentation;
    map?: Texture | null;
    sizeAttenuation?: boolean;
  }
  export class SpriteMaterial {
    constructor(parameters?: SpriteMaterialParameters);
    color: Color;
    map: Texture | null;
  }
  export interface SpriteMaterial extends Material {}

  /** Valeur d'un uniforme de shader. */
  export type UniformValue = number | boolean | Vector3 | Color | Matrix4 | Texture | null;
  export interface IUniform {
    value: UniformValue;
  }
  export interface ShaderMaterialParameters extends MaterialParameters {
    uniforms?: Record<string, IUniform>;
    vertexShader?: string;
    fragmentShader?: string;
  }
  export class ShaderMaterial {
    constructor(parameters?: ShaderMaterialParameters);
    uniforms: Record<string, IUniform>;
  }
  export interface ShaderMaterial extends Material {}

  export class Texture {
    readonly offset: Vector2Like;
    readonly repeat: Vector2Like;
    wrapS: Wrapping;
    wrapT: Wrapping;
    magFilter: TextureFilter;
    minFilter: TextureFilter;
    colorSpace: ColorSpace;
    generateMipmaps: boolean;
    set needsUpdate(value: boolean);
    dispose(): void;
  }

  /** Texture faite d'octets calculés (aucun chargement d'image ni de canevas, D-3d-17). */
  export class DataTexture extends Texture {
    constructor(data: Uint8Array | Uint8ClampedArray | null, width: number, height: number, format?: PixelFormat);
  }

  // --- Rendu -------------------------------------------------------------------------------------------------------------------

  export interface WebGLRendererParameters {
    canvas?: HTMLCanvasElement;
    antialias?: boolean;
    alpha?: boolean;
    powerPreference?: "default" | "high-performance" | "low-power";
    failIfMajorPerformanceCaveat?: boolean;
  }

  /** Compteurs du rendu : mémoire libérée (spéc. l.1170) et appels de dessin. */
  export interface WebGLInfo {
    readonly memory: { readonly geometries: number; readonly textures: number };
    readonly render: { readonly calls: number; readonly triangles: number };
  }

  export class WebGLRenderer {
    constructor(parameters?: WebGLRendererParameters);
    readonly domElement: HTMLCanvasElement;
    readonly info: WebGLInfo;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color: ColorRepresentation, alpha?: number): void;
    render(scene: Object3D, camera: PerspectiveCamera): void;
    getContext(): WebGL2RenderingContext;
    dispose(): void;
    forceContextLoss(): void;
  }
}
