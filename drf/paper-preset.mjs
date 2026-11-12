// Public scenario settings used in the upper-wall WM-P calibration.
export const PAPER_DOMAIN = Object.freeze([0, 100, -20, 50]);
export const PAPER_SETTINGS = Object.freeze({scene:'paper-upper', wallSide:'upper', snapshots:100,
  sigmaP:0, sigmaD:0.4, specular:true, roughness:0, lambda0:0, resolution:0.6});
export const candidateDomain = scene => scene === PAPER_SETTINGS.scene ? PAPER_DOMAIN : undefined;
