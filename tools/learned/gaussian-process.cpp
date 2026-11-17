// FP64 Gaussian process for the frozen GAT reconstruction.
#include <Eigen/Dense>
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

using namespace Eigen;
extern "C" void setulb(int,int,double*,double*,double*,int*,double*,double*,double,double,double*,int*,int*,int*,int*,double*,int,int*);

namespace {
// For L=[[A,0],[C,D]], the inverse's lower-left block is -D^{-1} C A^{-1}.
void invertLower(Ref<MatrixXd> L) {
    const Index n = L.rows();
    if (n <= 32) {
        MatrixXd inverse = L.triangularView<Lower>().solve(MatrixXd::Identity(n,n));
        L = inverse;
        return;
    }
    const Index a = n/2, b = n-a;
    auto A = L.topLeftCorner(a,a), D = L.bottomRightCorner(b,b), C = L.bottomLeftCorner(b,a);
    invertLower(A);
    invertLower(D);
    MatrixXd tmp = C * A.triangularView<Lower>();
    C.noalias() = -(D.triangularView<Lower>() * tmp);
}

// Store only the lower triangle of L^T L using its two triangular diagonal blocks.
void lowerGram(Ref<const MatrixXd> L, Ref<MatrixXd> result) {
    const Index n = L.rows();
    if (n <= 32) {
        result.noalias() = L.transpose() * L;
        return;
    }
    const Index a = n/2, b = n-a;
    auto C = L.bottomLeftCorner(b,a), D = L.bottomRightCorner(b,b);
    auto upperLeft = result.topLeftCorner(a,a);
    lowerGram(L.topLeftCorner(a,a), upperLeft);
    upperLeft.selfadjointView<Lower>().rankUpdate(C.transpose());
    result.bottomLeftCorner(b,a).noalias() = D.transpose().triangularView<Upper>() * C;
    lowerGram(D, result.bottomRightCorner(b,b));
}
}

// GP on measured GAT reflection points. Maximize the zero-mean RBF log marginal
// likelihood with the study's box constraints and ten L-BFGS-B iterations.
// Dense Cholesky is O(n^3) time and O(n^2) memory; callers apply the fleet cap.
extern "C" int gaussianProcess(const double *x,const double *y,int n,const double *query,int count,double *out) {
    Map<const VectorXd> xs(x,n),ys(y,n);
    MatrixXd dist=(xs.replicate(1,n)-xs.transpose().replicate(n,1)).array().square();
    double pars[]={std::log(std::max(ys.norm()/std::sqrt(n),1.)),std::log(5.),std::log(.4)};
    double low[]={std::log(.05),std::log(.1),std::log(.01)},high[]={std::log(200.),std::log(160.),std::log(60.)};
    int bounds[]={2,2,2},task[2]={},lsave[4]={},isave[44]={},iwa[9]={},line[2]={};
    double workspace[1420]={},dsave[29]={},loss=0,grad[3]={};
    std::array<double,3> factored={std::numeric_limits<double>::quiet_NaN(),0.,0.};
    LLT<MatrixXd> chol;
    MatrixXd cov;
    VectorXd alpha;
    auto factor=[&]() {
        double amp=std::exp(2*pars[0]),ell2=std::exp(2*pars[1]),noise=std::exp(2*pars[2]);
        cov=amp*(-.5/ell2*dist.array()).exp();
        MatrixXd k=cov;k.diagonal().array()+=noise+1e-8;chol.compute(k);
        if (chol.info()!=Success) return false;
        alpha=chol.solve(ys);std::copy_n(pars,3,factored.begin());return true;
    };
    int iterations=0;
    for (;;) {
        setulb(3,10,pars,low,high,bounds,&loss,grad,1e-8/std::numeric_limits<double>::epsilon(),1e-5,
               workspace,iwa,task,lsave,isave,dsave,20,line);
        if (task[0]==1) { if (++iterations==10) break; continue; }
        if (task[0]!=3) break;
        if (!factor()) return 0;
        loss=.5*ys.dot(alpha)+chol.matrixLLT().diagonal().array().log().sum();
        // K^{-1} = L^{-T} L^{-1}; its symmetry avoids two dense identity solves.
        MatrixXd lower=chol.matrixL(),w(n,n);
        invertLower(lower);
        lowerGram(lower,w);
        w.triangularView<StrictlyUpper>()=w.transpose();
        w.noalias()-=alpha*alpha.transpose();
        grad[0]=(w.array()*cov.array()).sum();
        grad[1]=.5*(w.array()*cov.array()*dist.array()).sum()/std::exp(2*pars[1]);
        grad[2]=std::exp(2*pars[2])*w.diagonal().sum();
    }
    // L-BFGS-B usually returns its last evaluation; reuse that exact factor and solution.
    if (!std::equal(factored.begin(),factored.end(),pars) && !factor()) return 0;
    const double variance=std::exp(2*pars[0]), scale=-.5/std::exp(2*pars[1]);
    for(int i=0;i<count;i++) out[i]=variance*
        ((scale*(xs.array()-query[i]).square()).exp()*alpha.array()).sum();
    return 1;
}
