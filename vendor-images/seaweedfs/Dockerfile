# Rebuild only the Go executable; retain the release's filesystem and entrypoint.
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/golang:1.26.9-alpine@sha256:cdfd4fe2da6b225d8b40c6b7a105736e548e83ff56d5d8f9394446eeb5eb84e0 AS builder
ENV GOTOOLCHAIN=local
ADD --checksum=sha256:2e042bfe3e0be78c97af2cd3f5502bdf0b204bfc110b68f719e1b5557ea5a1e0 https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/d997fba1575583a89cf0cc50dc0150642286c86d /tmp/source.tar.gz
RUN mkdir /source && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source
WORKDIR /source
COPY go.mod go.sum ./
RUN go mod download
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -mod=readonly -trimpath -buildvcs=false -ldflags '-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=d997fba-security' -o /weed ./weed

FROM mirror.gcr.io/chrislusf/seaweedfs:4.46@sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62
COPY --from=builder /weed /usr/bin/weed
