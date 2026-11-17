// Browser linear algebra for the frozen inference models. Matrices passed by JS use row-major storage.
#include <Eigen/Dense>
#include <cmath>
#include <cstdlib>
#include <algorithm>
using namespace Eigen;
using RowF = Matrix<float,Dynamic,Dynamic,RowMajor>;
extern "C" {

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
