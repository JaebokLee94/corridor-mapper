// Browser linear algebra for the frozen inference models. Matrices passed by JS use row-major storage.
#include <Eigen/Dense>
#include <wasm_simd128.h>
#include "gp-simd.hpp"
#include <cmath>
#include <cstdlib>
#include <limits>
#include <array>
#include <algorithm>
using namespace Eigen;
using RowF = Matrix<float,Dynamic,Dynamic,RowMajor>;
// NHWC [H,W,In] × [K,K,In,64]; O(H*W*K²*In*64), constant scratch memory.
// Preserve Eigen 5.0.1 FP32 channel sums, including sequential spatial tails.
template<int In>
void convolution64(const float *image,const float *weights,const float *bias,float *out,
                   int height,int width,int kernel,int dilationY,int dilationX) {
    for(int p=0;p<height*width;p++)for(int c=0;c<64;c+=4)
        wasm_v128_store(out+p*64+c,wasm_v128_load(bias+c));
    for(int ky=0;ky<kernel;ky++)for(int kx=0;kx<kernel;kx++) {
        const int dx=(kx-kernel/2)*dilationX,dy=(ky-kernel/2)*dilationY;
        const int begin=std::max(0,-dx),count=width-std::abs(dx),panels=count/4*4;
        if(count<=0)continue;
        const float *w=weights+(ky*kernel+kx)*In*64;
        for(int y=std::max(0,-dy);y<std::min(height,height-dy);y++) {
            const float *src=image+((y+dy)*width+begin+dx)*In;
            float *dest=out+(y*width+begin)*64;
            int x=0;
            for(;x<panels;x+=4)for(int o=0;o<64;o+=4) {
                v128_t e0=wasm_f32x4_splat(0),e1=e0,e2=e0,e3=e0;
                v128_t o0=e0,o1=e0,o2=e0,o3=e0;
                int c=0;
                for(;c<In/8*8;c+=2) {
                    const v128_t we=wasm_v128_load(w+c*64+o),wo=wasm_v128_load(w+(c+1)*64+o);
                    e0=wasm_f32x4_add(e0,wasm_f32x4_mul(wasm_f32x4_splat(src[x*In+c]),we));
                    e1=wasm_f32x4_add(e1,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+1)*In+c]),we));
                    e2=wasm_f32x4_add(e2,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+2)*In+c]),we));
                    e3=wasm_f32x4_add(e3,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+3)*In+c]),we));
                    o0=wasm_f32x4_add(o0,wasm_f32x4_mul(wasm_f32x4_splat(src[x*In+c+1]),wo));
                    o1=wasm_f32x4_add(o1,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+1)*In+c+1]),wo));
                    o2=wasm_f32x4_add(o2,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+2)*In+c+1]),wo));
                    o3=wasm_f32x4_add(o3,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+3)*In+c+1]),wo));
                }
                e0=wasm_f32x4_add(e0,o0);e1=wasm_f32x4_add(e1,o1);
                e2=wasm_f32x4_add(e2,o2);e3=wasm_f32x4_add(e3,o3);
                for(;c<In;c++) {
                    const v128_t wc=wasm_v128_load(w+c*64+o);
                    e0=wasm_f32x4_add(e0,wasm_f32x4_mul(wasm_f32x4_splat(src[x*In+c]),wc));
                    e1=wasm_f32x4_add(e1,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+1)*In+c]),wc));
                    e2=wasm_f32x4_add(e2,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+2)*In+c]),wc));
                    e3=wasm_f32x4_add(e3,wasm_f32x4_mul(wasm_f32x4_splat(src[(x+3)*In+c]),wc));
                }
                wasm_v128_store(dest+x*64+o,wasm_f32x4_add(wasm_v128_load(dest+x*64+o),e0));
                wasm_v128_store(dest+(x+1)*64+o,wasm_f32x4_add(wasm_v128_load(dest+(x+1)*64+o),e1));
                wasm_v128_store(dest+(x+2)*64+o,wasm_f32x4_add(wasm_v128_load(dest+(x+2)*64+o),e2));
                wasm_v128_store(dest+(x+3)*64+o,wasm_f32x4_add(wasm_v128_load(dest+(x+3)*64+o),e3));
            }
            for(;x<count;x++)for(int o=0;o<64;o+=4) {
                v128_t sum=wasm_f32x4_splat(0);
                for(int c=0;c<In;c++)sum=wasm_f32x4_add(sum,wasm_f32x4_mul(wasm_f32x4_splat(src[x*In+c]),wasm_v128_load(w+c*64+o)));
                wasm_v128_store(dest+x*64+o,wasm_f32x4_add(wasm_v128_load(dest+x*64+o),sum));
            }
        }
    }
}
extern "C" {
void setulb(int,int,double*,double*,double*,int*,double*,double*,double,double,double*,int*,int*,int*,int*,double*,int,int*);

void multiply(const float *a,const float *b,float *out,int rows,int inner,int cols) {
    Map<RowF>(out,rows,cols).noalias() = Map<const RowF>(a,rows,inner) * Map<const RowF>(b,inner,cols);
}

// NHWC image; weights in [kernel row, kernel column, input channel, output channel] order.
void convolutionXY(const float *image,const float *weights,const float *bias,float *out,
                 int height,int width,int in,int channels,int kernel,int dilationY,int dilationX) {
    if(channels==64 && in==26){convolution64<26>(image,weights,bias,out,height,width,kernel,dilationY,dilationX);return;}
    if(channels==64 && in==64){convolution64<64>(image,weights,bias,out,height,width,kernel,dilationY,dilationX);return;}
    Map<RowF> result(out,height*width,channels);
    result.rowwise() = Map<const RowVectorXf>(bias,channels);
    for (int ky=0;ky<kernel;ky++) for (int kx=0;kx<kernel;kx++) {
        int dx=(kx-kernel/2)*dilationX,dy=(ky-kernel/2)*dilationY;
        int begin=std::max(0,-dx),count=width-std::abs(dx);
        if(count<=0) continue;
        Map<const RowF> w(weights+(ky*kernel+kx)*in*channels,in,channels);
        for (int y=std::max(0,-dy);y<std::min(height,height-dy);y++) {
            Map<const RowF> src(image+((y+dy)*width+begin+dx)*in,count,in);
            result.middleRows(y*width+begin,count).noalias() += src*w;
        }
    }
}

void convolution(const float *image,const float *weights,const float *bias,float *out,
                 int height,int width,int in,int channels,int kernel,int dilation) {
    convolutionXY(image,weights,bias,out,height,width,in,channels,kernel,dilation,dilation);
}

// xy [cells,2], configurations [count,13], sorted paths [paths,3] in metres.
// Sum normalized ellipse likelihood and its horizontal normal moments.
// O(cells*configs*(log paths + nearby paths)), O(cells) output memory.
void rangeVotes(const float *xy,const float *configs,const float *paths,float *out,
                int cells,int count,int links) {
    for(int j=0;j<cells;j++) {
        float mass=0,first=0,second=0;
        for(int c=0;c<count;c++) {
            const float *p=configs+c*13;
            float ax=xy[j*2]-p[0],ay=xy[j*2+1]-p[1],bx=xy[j*2]-p[2],by=xy[j*2+1]-p[3];
            float ra=std::max(1e-9f,std::sqrt(ax*ax+ay*ay)),rb=std::max(1e-9f,std::sqrt(bx*bx+by*by));
            const float rho=ra+rb,lower=rho-p[12],upper=rho+p[12];
            const int begin=int(p[10]),end=begin+int(p[11]);
            int lo=begin,hi=end;
            while(lo<hi){int mid=(lo+hi)/2;if(paths[3*mid]<lower)lo=mid+1;else hi=mid;}
            // Empty finite likelihoods add exactly zero; keep the admitted-path reduction order.
            if(std::isfinite(rho) && (lo==end || paths[3*lo]>upper))continue;
            ax/=ra;ay/=ra;bx/=rb;by/=rb;
            const float gx=ax+bx,gy=ay+by,norm=std::max(1e-9f,std::sqrt(gx*gx+gy*gy));
            const float var=p[4]*ax*ax+2*p[5]*ax*ay+p[6]*ay*ay+p[7]*bx*bx+2*p[8]*bx*by+p[9]*by*by;
            float total=0;
            for(int k=lo;k<end&&paths[3*k]<=upper;k++) {
                const float *path=paths+3*k,sd=std::sqrt(std::max(1e-12f,path[1]+var));
                const float residual=(rho-path[0])/sd;
                total+=std::exp(-.5f*residual*residual)*path[2]/sd;
            }
            total*=norm/2.5066282746310005f;
            const float nx=gx/norm;
            mass+=total;first+=total*nx;second+=total*nx*nx;
        }
        out[j*3]=std::log1p(3.f/std::max(1,links)*mass);
        out[j*3+1]=first/std::max(1e-12f,mass);
        out[j*3+2]=second/std::max(1e-12f,mass);
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
