export const rightMethods={
  gat:{name:'GAT + GPR',curves:true,description:'Jung et al. GAT on four measured snapshots, followed by DBSCAN and Gaussian process regression.'},
  wmp:{name:'WM-P',description:'Wall Mapping with Pair Tracking'},
  gbdt:{name:'EchoSpline-GBDT',curves:true,description:'Frozen height-residual trees on the 2 m EchoSpline fit with 8 m support.'},
  'spline-cnn':{name:'EchoSpline-CNN (Rugged Wall Recovery)',curves:true,description:'A CNN combines multiscale reflection candidates and measured ranges around an EchoSpline-GBDT anchor. Dynamic programming selects one wall profile per supported interval.'},
  'pair-ridge':{name:'EchoSpline-Ridge (Computational Reduction)',curves:true,pairSelector:'ridge',description:'Ridge selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  'pair-gbdt':{name:'EchoSpline-GBDT (Computational Reduction)',curves:true,pairSelector:'gbdt',description:'GBDT selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  'pair-extra-trees':{name:'EchoSpline-ExtraTrees (Computational Reduction)',curves:true,pairSelector:'extraTrees',description:'ExtraTrees selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  // Retain EchoArc for shared URLs and saved runs; it is hidden from the menu.
  arc:{name:'EchoArc-CNN',curves:true,description:'Upper-arc ellipse votes and a frozen CNN. Peak probability threshold 0.70.'}
};
