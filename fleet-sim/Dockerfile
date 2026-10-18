FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /fleet-sim .

FROM gcr.io/distroless/static-debian12
COPY --from=build /fleet-sim /fleet-sim
EXPOSE 8080
ENTRYPOINT ["/fleet-sim"]
