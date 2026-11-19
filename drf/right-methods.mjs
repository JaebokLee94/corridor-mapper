export const rightMethods={
  gat:{name:'GAT + GPR',curves:true,description:'Jung et al. GAT on four measured snapshots, followed by DBSCAN and Gaussian process regression.'},
  wmp:{name:'WM-P',description:'Wall Mapping with Pair Tracking'},
  gbdt:{name:'EchoSpline-GBDT',curves:true,description:'Frozen height-residual trees on the 2 m EchoSpline fit with 8 m support.'},
  'spline-cnn':{name:'이전 EchoSpline-CNN',curves:true,deprecated:true,description:'거리 특징을 사용한 이전 모델입니다. 저장된 결과를 식별하기 위해 남겨 두며 새 계산에는 사용하지 않습니다.'},
  'spline-cnn-fast':{name:'EchoSpline-CNN',curves:true,description:'이전 EchoSpline-CNN에서 증류한 모델로, 거리 특징 이미지 계산을 생략하고 반사 후보와 EchoSpline-GBDT 추정을 결합합니다. 지도는 관측 4개마다, 그리고 마지막 관측에서 다시 계산합니다.'},
  'pair-ridge':{name:'EchoSpline-Ridge (Computational Reduction)',curves:true,pairSelector:'ridge',description:'Ridge selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  'pair-gbdt':{name:'EchoSpline-GBDT (Computational Reduction)',curves:true,pairSelector:'gbdt',description:'GBDT selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  'pair-extra-trees':{name:'EchoSpline-ExtraTrees (Computational Reduction)',curves:true,pairSelector:'extraTrees',description:'ExtraTrees selects up to 10 measured pairs every 10 snapshots; EchoSpline updates the wall at every snapshot. Frozen pair-selection model trained on 3, 5, 7 and 10 vehicles.'},
  // Retain EchoArc for shared URLs and saved runs; it is hidden from the menu.
  arc:{name:'EchoArc-CNN',curves:true,description:'Upper-arc ellipse votes and a frozen CNN. Peak probability threshold 0.70.'}
};

export const activeRightMethods=Object.keys(rightMethods).filter(id=>!rightMethods[id].deprecated);

// Migrate new execution requests only; saved result IDs retain their original meaning.
export function canonicalRightMethod(id){
  return id==='spline-cnn'?'spline-cnn-fast':id==='wmf'?'wmp':id??'wmp';
}
