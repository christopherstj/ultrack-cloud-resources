import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const PROJECT_ID = "animated-cell-381917";

const envType = pulumi.getStack();

const cfg = new pulumi.Config();

// Encryption Keys

const cmekSettings = gcp.logging.getProjectCmekSettings({
    project: PROJECT_ID,
});

const keyring = new gcp.kms.KeyRing(`${envType}-keyring`, {
    location: "us",
});

const key = new gcp.kms.CryptoKey(`${envType}-storage-key`, {
    keyRing: keyring.id,
    rotationPeriod: "100000s",
});

const cryptoKeyBinding = new gcp.kms.CryptoKeyIAMBinding("cryptoKeyBinding", {
    cryptoKeyId: key.id,
    role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
    members: [
        cmekSettings.then(
            (cmekSettings) => `serviceAccount:${cmekSettings.serviceAccountId}`
        ),
        `serviceAccount:${cfg.require("root-service-account")}`,
    ],
});

// File Bucket

const fitFileBucket = new gcp.storage.Bucket(`${envType}-fit-file-bucket`, {
    // autoclass: {
    //     enabled: false,
    // },
    cors: [
        {
            maxAgeSeconds: 3600,
            methods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
            responseHeaders: ["*"],
        },
    ],
    forceDestroy: true,
    location: "US",
    labels: {
        env: "dev",
    },
    lifecycleRules: [
        {
            action: {
                type: "SetStorageClass",
                storageClass: "NEARLINE",
            },
            condition: {
                age: 30,
            },
        },
        {
            action: {
                type: "SetStorageClass",
                storageClass: "COLDLINE",
            },
            condition: {
                age: 90,
            },
        },
        {
            action: {
                type: "SetStorageClass",
                storageClass: "ARCHIVE",
            },
            condition: {
                age: 365,
            },
        },
    ],
    encryption: {
        defaultKmsKeyName: key.id,
    },
});

const gcsAccount = gcp.storage.getProjectServiceAccount({});

// Logs

const projectLogs = new gcp.logging.ProjectBucketConfig(
    `${envType}-project-logs`,
    {
        project: PROJECT_ID,
        location: "global",
        retentionDays: 30,
        bucketId: `${envType}-project-logs`,
    }
);

// SQL Database

const mysqlDbInstance = new gcp.sql.DatabaseInstance("mysql-db-instance", {
    databaseVersion: "MYSQL_8_0",
    region: "us-west1",
    project: PROJECT_ID,
    rootPassword: cfg.requireSecret("db-root-password"),
    settings: {
        tier: "db-f1-micro",
        databaseFlags: [
            {
                name: "cloudsql_iam_authentication",
                value: "on",
            },
        ],
    },
});

const mysqlDB = new gcp.sql.Database(`${envType}-db`, {
    instance: mysqlDbInstance.name,
    project: PROJECT_ID,
    collation: "utf8_general_ci",
    name: `${envType}-db`,
});

const webAppSa = new gcp.sql.User("web-app-sa", {
    name: "web-app-sa@projectid.iam.gserviceaccount.com",
    instance: mysqlDbInstance.name,
    type: "CLOUD_IAM_SERVICE_ACCOUNT",
});

const webAppBi = new gcp.sql.User("web-app-bi", {
    project: PROJECT_ID,
    instance: mysqlDbInstance.name,
    type: "BUILT_IN",
    name: "web-app-bi",
    password: cfg.requireSecret("web-app-bi-password"),
});

// Pub/Sub

const k8sTransportTopic = new gcp.pubsub.Topic("k8s-transport-topic", {
    project: PROJECT_ID,
});

const k8sTransportSub = new gcp.pubsub.Subscription("k8s-transport-sub", {
    topic: k8sTransportTopic.name,
    project: PROJECT_ID,
});

const notificationBinding = new gcp.pubsub.TopicIAMBinding(
    `${envType}-notification-binding`,
    {
        topic: k8sTransportTopic.id,
        role: "roles/pubsub.publisher",
        members: [
            gcsAccount.then(
                (gcsAccount) => `serviceAccount:${gcsAccount.emailAddress}`
            ),
        ],
    }
);

const pythonNotification = new gcp.storage.Notification(
    `${envType}-python-notification`,
    {
        bucket: fitFileBucket.name,
        payloadFormat: "JSON_API_V1",
        topic: k8sTransportTopic.id,
        eventTypes: ["OBJECT_FINALIZE"],
        customAttributes: {
            env: envType,
        },
    },
    {
        dependsOn: [notificationBinding],
    }
);

// Artifact Registry

const npmRepo = new gcp.artifactregistry.Repository("npm-repo", {
    description: "Private NPM Package Repo ",
    format: "NPM",
    location: "us-west1",
    repositoryId: "npm-repo",
});

// CICD

const libsTrigger = new gcp.cloudbuild.Trigger("libs-trigger", {
    filename: "libs/_CICD/libs-deployment.yaml",
    location: "global",
    github: {
        name: "ultrack",
        owner: "christopherstj",
        push: {
            branch: "^main$",
        },
    },
    includedFiles: ["libs/*"],
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
});
