// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SecretaryCore",
    platforms: [.iOS("26.0"), .macOS(.v14)],
    products: [.library(name: "SecretaryCore", targets: ["SecretaryCore"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.38.1"),
        .package(url: "https://github.com/connectrpc/connect-swift.git", exact: "1.2.3"),
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
    ],
    targets: [
        .target(name: "SecretaryCore", dependencies: [
            .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            .product(name: "Connect", package: "connect-swift"),
            .product(name: "GRDB", package: "GRDB.swift"),
        ], path: "Secretary/Core"),
        .testTarget(name: "SecretaryCoreTests", dependencies: ["SecretaryCore"], path: "SecretaryTests"),
    ]
)
