// Browser linear algebra for the frozen inference models. Matrices passed by JS use row-major storage.
#include <Eigen/Dense>
#include "gp-simd.hpp"
#include <cmath>
#include <cstdlib>
#include <limits>
#include <array>
#include <algorithm>
using namespace Eigen;
using RowF = Matrix<float,Dynamic,Dynamic,RowMajor>;
extern "C" {
void setulb(int,int,double*,double*,double*,int*,double*,double*,double,double,double*,int*,int*,int*,int*,double*,int,int*);

void multiply(const float *a,const float *b,float *out,int rows,int inner,int cols) {
    Map<RowF>(out,rows,cols).noalias() = Map<const RowF>(a,rows,inner) * Map<const RowF>(b,inner,cols);
}

// NHWC image; weights in [kernel row, kernel column, input channel, output channel] order.
void convolution(const float *image,const float *weights,const float *bias,float *out,
                 int height,int width,int in,int channels,int kernel,int dilation) {
    Map<RowF> result(out,height*width,channels);
    result.rowwise() = Map<const RowVectorXf>(bias,channels);
    for (int ky=0;ky<kernel;ky++) for (int kx=0;kx<kernel;kx++) {
        int dx=(kx-kernel/2)*dilation,dy=(ky-kernel/2)*dilation;
        int begin=std::max(0,-dx),count=width-std::abs(dx);
        Map<const RowF> w(weights+(ky*kernel+kx)*in*channels,in,channels);
        for (int y=std::max(0,-dy);y<std::min(height,height-dy);y++) {
            Map<const RowF> src(image+((y+dy)*width+begin+dx)*in,count,in);
            result.middleRows(y*width+begin,count).noalias() += src*w;
        }
    }
}

// GP on measured GAT reflection points. Maximize the zero-mean RBF log marginal
// likelihood with the study's box constraints and ten L-BFGS-B iterations.
// Dense Cholesky is O(n^3) time and O(n^2) memory; callers apply the fleet cap.
int gaussianProcess(const double *x,const double *y,int n,const double *query,int count,double *out) {
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
        MatrixXd w=chol.solve(MatrixXd::Identity(n,n))-alpha*alpha.transpose();
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

// The optimizer's small work arrays use Fortran BLAS column strides.
void daxpy_(int*n,double*a,double*x,int*incX,double*y,int*incY){for(int k=0;k<*n;k++)y[k * *incY]+=*a*x[k * *incX];}
void dscal_(int*n,double*a,double*x,int*incX){for(int k=0;k<*n;k++)x[k * *incX]*=*a;}
void dcopy_(int*n,double*x,int*incX,double*y,int*incY){for(int k=0;k<*n;k++)y[k * *incY]=x[k * *incX];}
double ddot_(int*n,double*x,int*incX,double*y,int*incY){double r=0;for(int k=0;k<*n;k++)r+=x[k * *incX]*y[k * *incY];return r;}
double dnrm2_(int*n,double*x,int*incX){return std::sqrt(ddot_(n,x,incX,x,incX));}
void dpotrf_(char*,int*n,double*a,int*lda,int*info){
    Map<MatrixXd,0,OuterStride<>> m(a,*n,*n,OuterStride<>(*lda));
    LLT<MatrixXd,Upper> ch(m.selfadjointView<Upper>());*info=ch.info()==Success?0:1;
    if (!*info) m.triangularView<Upper>()=ch.matrixU();
}
void dtrtrs_(char*,char*trans,char*,int*n,int*nrhs,double*a,int*lda,double*b,int*ldb,int*info){
    Map<MatrixXd,0,OuterStride<>> m(a,*n,*n,OuterStride<>(*lda)),rhs(b,*n,*nrhs,OuterStride<>(*ldb));
    *info=0;
    for(int i=0;i<*n;i++) if(m(i,i)==0){*info=i+1;return;}
    if (*trans=='N') m.triangularView<Upper>().solveInPlace(rhs);
    else m.transpose().triangularView<Lower>().solveInPlace(rhs);
}
}
