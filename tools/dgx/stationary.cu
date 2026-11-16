// Screen the measured Tx/Rx path on the simulator grid. The host applies the exact acceptance rules.
#include <node_api.h>
#include <cuda_runtime.h>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace {
constexpr unsigned tile=256;

__device__ double path_length(const double* p,double x,double y) {
    const double ax=x-p[0], ay=y-p[1], bx=x-p[2], by=y-p[3];
    return sqrt(ax*ax+ay*ay)+sqrt(bx*bx+by*by);
}

__global__ void extrema(const double* x,const double* sensors,const double* heights,
                        int n,int sign,uint32_t* mask) {
    __shared__ double path[tile+2];
    const unsigned t=threadIdx.x;
    const int i=blockIdx.x*tile+t, pair=blockIdx.y;
    const double* p=sensors+4*pair;
    if(i<n) path[t+1]=path_length(p,x[i],heights[i]);
    if(t==0 && i>0) path[0]=path_length(p,x[i-1],heights[i-1]);
    if(t==tile-1 && i+1<n) path[tile+1]=path_length(p,x[i+1],heights[i+1]);
    __syncthreads();
    bool keep=false;
    if(i>0 && i<n-1 && sign*heights[i]>=fmax(sign*p[1],sign*p[3])) {
        const double left=path[t+1]-path[t], right=path[t+2]-path[t+1];
        const double guard=128.*2.2204460492503131e-16*fmax(1.,fmax(path[t+1],fmax(path[t],path[t+2])));
        keep=!isfinite(left) || !isfinite(right) || fabs(left)<=guard || fabs(right)<=guard || ((left<0.)!=(right<0.));
    }
    const uint32_t bits=__ballot_sync(0xffffffff,keep);
    if((t&31)==0 && i<n) mask[(size_t)pair*((n+31)/32)+i/32]=bits;
}

void check(cudaError_t e) {
    if(e!=cudaSuccess) throw std::runtime_error(cudaGetErrorString(e));
}

// Each Node environment owns its allocation; synchronous inference may reuse it across snapshots.
struct Workspace {
    void* data=nullptr;
    size_t size=0;
    ~Workspace(){if(data) cudaFree(data);}
    void reserve(size_t n) {
        if(n<=size) return;
        void* next=nullptr;
        check(cudaMalloc(&next,n));
        if(data) cudaFree(data);
        data=next; size=n;
    }
};
void cleanup(void* ptr) {delete static_cast<Workspace*>(ptr);}
struct View {void* data; size_t size;};
View typed(napi_env env,napi_value value,napi_typedarray_type expected) {
    napi_typedarray_type type; size_t n,offset; void* data; napi_value ab;
    if(napi_get_typedarray_info(env,value,&type,&n,&data,&ab,&offset)!=napi_ok || type!=expected)
        throw std::runtime_error("Invalid typed array for stationary-path search");
    return {data,n};
}
napi_value mark(napi_env env,napi_callback_info info) {
    try {
        size_t narg=5; napi_value a[5]; void* opaque=nullptr;
        if(napi_get_cb_info(env,info,&narg,a,nullptr,&opaque)!=napi_ok || narg!=5)
            throw std::runtime_error("Expected grid, sensor pairs, heights, sign and mask");
        const auto x=typed(env,a[0],napi_float64_array), p=typed(env,a[1],napi_float64_array);
        const auto y=typed(env,a[2],napi_float64_array), out=typed(env,a[4],napi_uint32_array);
        double sign; const size_t jobs=p.size/4, words=(x.size+31)/32;
        if(x.size<3 || x.size>std::numeric_limits<int>::max()-32 || x.size!=y.size || !jobs ||
           jobs>65535 || p.size%4 || out.size!=jobs*words || napi_get_value_double(env,a[3],&sign)!=napi_ok ||
           (sign!=1. && sign!=-1.)) throw std::runtime_error("Invalid stationary-path dimensions or sign");
        auto* ws=static_cast<Workspace*>(opaque);
        ws->reserve((2*x.size+p.size)*sizeof(double)+out.size*sizeof(uint32_t));
        auto* gx=static_cast<double*>(ws->data); auto* gp=gx+x.size; auto* gy=gp+p.size;
        auto* mask=reinterpret_cast<uint32_t*>(gy+y.size);
        check(cudaMemcpy(gx,x.data,x.size*sizeof(double),cudaMemcpyHostToDevice));
        check(cudaMemcpy(gp,p.data,p.size*sizeof(double),cudaMemcpyHostToDevice));
        check(cudaMemcpy(gy,y.data,y.size*sizeof(double),cudaMemcpyHostToDevice));
        extrema<<<dim3((x.size+tile-1)/tile,jobs),tile>>>(gx,gp,gy,x.size,static_cast<int>(sign),mask);
        check(cudaGetLastError());
        check(cudaMemcpy(out.data,mask,out.size*sizeof(uint32_t),cudaMemcpyDeviceToHost));
        return a[4];
    } catch(const std::exception& e) {napi_throw_error(env,nullptr,e.what());return nullptr;}
}
}
NAPI_MODULE_INIT() {
    auto* ws=new Workspace;
    if(napi_add_env_cleanup_hook(env,cleanup,ws)!=napi_ok) {
        delete ws;napi_throw_error(env,nullptr,"Could not initialise CUDA workspace");return nullptr;
    }
    napi_value fn;
    if(napi_create_function(env,"mark",NAPI_AUTO_LENGTH,mark,ws,&fn)!=napi_ok ||
       napi_set_named_property(env,exports,"mark",fn)!=napi_ok) {
        napi_throw_error(env,nullptr,"Could not register stationary-path search");return nullptr;
    }
    return exports;
}
