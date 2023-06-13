import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";

const PROJECT_ID = "animated-cell-381917";

const location = "us-central1";

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

// Create the network for the GKE cluster
const network = new gcp.compute.Network(`${envType}-gke-webserver-network`, {
  autoCreateSubnetworks: false,
});

// Create subnetwork for GKE cluster
const subnetwork1 = new gcp.compute.Subnetwork(
  `${envType}-gke-webserver-subnetwork1`,
  {
    ipCidrRange: "10.128.0.0/12",
    network: network.id,
    privateIpGoogleAccess: true,
    region: location,
  }
);

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

const mysqlDbInstance2 = new gcp.sql.DatabaseInstance(
  "ultrack-mysql-instance",
  {
    databaseVersion: "MYSQL_8_0",
    region: location,
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
      ipConfiguration: {
        privateNetwork: network.id,
      },
    },
  }
);

export const instanceName = mysqlDbInstance2.name;

const mysqlDB = new gcp.sql.Database(`${envType}-db`, {
  instance: mysqlDbInstance.name,
  project: PROJECT_ID,
  collation: "utf8_general_ci",
  name: `${envType}-db`,
});

const mysqlDB2 = new gcp.sql.Database(`${envType}-portal-db`, {
  instance: mysqlDbInstance2.name,
  project: PROJECT_ID,
  collation: "utf8_general_ci",
  name: `${envType}-portal-data`,
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
  password: cfg.requireSecret("mysql-password"),
});

const webAppSa2 = new gcp.sql.User("web-app-sa-2", {
  name: "web-app-sa@projectid.iam.gserviceaccount.com",
  instance: mysqlDbInstance2.name,
  type: "CLOUD_IAM_SERVICE_ACCOUNT",
});

const webAppBi2 = new gcp.sql.User("web-app-bi-2", {
  project: PROJECT_ID,
  instance: mysqlDbInstance2.name,
  type: "BUILT_IN",
  name: "web-app-bi",
  password: cfg.requireSecret("mysql-password"),
});

// Artifact Registry

const npmRepo = new gcp.artifactregistry.Repository("npm-repo", {
  description: "Private NPM Package Repo ",
  format: "NPM",
  location: location,
  repositoryId: "npm-repo",
});

// NPM Libs

const libsTrigger = new gcp.cloudbuild.Trigger("libs-trigger", {
  filename: "libs/_CICD/libs-deployment.yaml",
  location: location,
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

// Docker

const dockerRegistry = new gcp.artifactregistry.Repository("docker-repo", {
  description: "example docker repository",
  format: "DOCKER",
  location: location,
  repositoryId: "docker-repo",
});

const dockerRegistryUrl = dockerRegistry.id.apply((_) =>
  gcp.container.getRegistryRepository().then((reg) => reg.repositoryUrl)
);

// Kubernetes

// Create a GKE Autopilot cluster
const cluster = new gcp.container.Cluster(
  `web-cluster`,
  {
    location: location,
    name: `web-cluster`,
    network: network.name,
    binaryAuthorization: {
      evaluationMode: "PROJECT_SINGLETON_POLICY_ENFORCE",
    },
    masterAuthorizedNetworksConfig: {
      cidrBlocks: [
        {
          cidrBlock: "0.0.0.0/0",
          displayName: "All networks",
        },
      ],
    },
    subnetwork: subnetwork1.selfLink,
    enableAutopilot: true,
    ipAllocationPolicy: {
      clusterIpv4CidrBlock: "/14",
      servicesIpv4CidrBlock: "/20",
    },
    privateClusterConfig: {
      enablePrivateNodes: true,
      enablePrivateEndpoint: false,
      masterIpv4CidrBlock: "10.100.0.0/28",
    },
  },
  {
    dependsOn: [network, subnetwork1],
  }
);

const clusterKubeconfig = pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${cluster.masterAuth.clusterCaCertificate}
    server: https://${cluster.endpoint}
  name: ${cluster.name}
contexts:
- context:
    cluster: ${cluster.name}
    user: ${cluster.name}
  name: ${cluster.name}
current-context: ${cluster.name}
kind: Config
preferences: {}
users:
- name: ${cluster.name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`;

// Create a Kubernetes provider instance that uses our cluster from above.
const provider = new k8s.Provider(`${envType}-ultrack-provider`, {
  kubeconfig: clusterKubeconfig,
});

const namespace = new k8s.core.v1.Namespace(
  `${envType}-ultrack`,
  {
    metadata: {
      name: `${envType}-ultrack`,
    },
  },
  {
    provider,
  }
);

const rabbitMqOperator = new k8s.yaml.ConfigFile("rabbit-mq-operator", {
  file: "cluster-operator.yml",
});

const rabbitMqCluster = new k8s.apiextensions.CustomResource(
  `${envType}-rabbitmq-cluster`,
  {
    apiVersion: "rabbitmq.com/v1beta1",
    kind: "RabbitmqCluster",
    metadata: {
      name: "rabbit-cluster-dev",
    },
    spec: {
      image:
        "us-central1-docker.pkg.dev/animated-cell-381917/docker-repo/rabbitmq:latest",
      replicas: 1,
      resources: {
        requests: {
          cpu: 1,
          memory: "3Gi",
        },
        limits: {
          cpu: 1,
          memory: "3Gi",
        },
      },
      rabbitmq: {
        additionalConfig: pulumi.interpolate`log.console.level = debug\n
          default_user = web-app\n
          default_pass = ${cfg.getSecret("rabbitmq-password")}`,
      },
    },
  }
);

const k8sServiceAccount = new k8s.core.v1.ServiceAccount(
  `${envType}-service-account`,
  {
    metadata: {
      name: `${envType}-service-account`,
      namespace: namespace.id,
    },
  }
);

const secrets: pulumi.Input<pulumi.Input<k8s.types.input.core.v1.EnvVar>[]> = [
  {
    name: "MYSQL_USER_NAME",
    value: cfg.getSecret("mysql-username"),
  },
  {
    name: "MYSQL_USER_PASSWORD",
    value: cfg.getSecret("mysql-password"),
  },
  {
    name: "MYSQL_HOST",
    value: "127.0.0.1",
  },
  {
    name: "MYSQL_DB",
    value: `${envType}-portal-data`,
  },
  {
    name: "JWT_SECRET",
    value: cfg.getSecret("jwt-token"),
  },
  {
    name: "PROJECT_ID",
    value: PROJECT_ID,
  },
  {
    name: "RABBITMQ_IP",
    value: pulumi.interpolate`web-app:${cfg.getSecret(
      "rabbitmq-password"
    )}@10.172.6.170`,
  },
];

const readinessProbe: pulumi.Input<k8s.types.input.core.v1.Probe> = {
  httpGet: {
    path: "/",
    port: 80,
  },
  initialDelaySeconds: 300,
  periodSeconds: 30,
};

const livenessProbe: pulumi.Input<k8s.types.input.core.v1.Probe> = {
  httpGet: {
    path: "/",
    port: 80,
  },
  initialDelaySeconds: 300,
  periodSeconds: 30,
};

const serverDeployment = new k8s.apps.v1.Deployment(
  `${envType}-server-deployment`,
  {
    metadata: {
      labels: {
        app: "server",
      },
      name: "server-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "server",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "server",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/${PROJECT_ID}/docker-repo/server:93d3dbb`,
              name: "server",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              env: secrets,
              readinessProbe,
              livenessProbe,
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
            },
          ],
        },
      },
    },
  }
);

const serverTrigger = new gcp.cloudbuild.Trigger("server-trigger", {
  location: location,
  github: {
    name: "ultrack",
    owner: "christopherstj",
    push: {
      branch: "^main$",
    },
  },
  includedFiles: ["server/**/*"],
  serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
  build: {
    steps: [
      {
        name: "gcr.io/cloud-builders/npm",
        args: ["run", "artifactregistry-login"],
        dir: "./server",
      },
      {
        name: "gcr.io/cloud-builders/npm",
        args: ["run", "artifactregistry-auth-npmrc"],
        dir: "./server",
      },
      {
        name: "gcr.io/cloud-builders/docker",
        id: "Build",
        args: [
          "build",
          "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
          "--network=cloudbuild",
          "--target",
          "production",
          "-t",
          `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/server:$SHORT_SHA`,
          "./server",
        ],
      },
      {
        name: "gcr.io/cloud-builders/docker",
        id: "Push",
        args: [
          "push",
          `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/server:$SHORT_SHA`,
        ],
      },
      {
        name: "gcr.io/cloud-builders/kubectl",
        id: "Deploy to dev",
        args: [
          "set",
          "image",
          "deployment/server-deployment",
          `server=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/server:$SHORT_SHA`,
          "--namespace",
          pulumi.interpolate`${namespace.id}`,
        ],
        envs: [
          pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
          `CLOUDSDK_COMPUTE_REGION=${location}`,
        ],
      },
    ],
    images: [
      `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/server:$SHORT_SHA`,
    ],
    options: {
      logging: "CLOUD_LOGGING_ONLY",
    },
    substitutions: {
      _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
    },
  },
});

const cloudStorageDeployment = new k8s.apps.v1.Deployment(
  `${envType}-cloud-storage-deployment`,
  {
    metadata: {
      labels: {
        app: "cloud-storage",
      },
      name: "cloud-storage-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "cloud-storage",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "cloud-storage",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/cloud-storage:09b2470`,
              name: "cloud-storage",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              env: secrets,
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
              // readinessProbe,
              // livenessProbe,
            },
          ],
        },
      },
    },
  }
);

const cloudStorageTrigger = new gcp.cloudbuild.Trigger(
  "cloud-storage-trigger",
  {
    location: location,
    github: {
      name: "ultrack",
      owner: "christopherstj",
      push: {
        branch: "^main$",
      },
    },
    includedFiles: ["cloud-storage/**/*"],
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
    build: {
      steps: [
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-login"],
          dir: "./cloud-storage",
        },
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-auth-npmrc"],
          dir: "./cloud-storage",
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Build",
          args: [
            "build",
            "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
            "--network=cloudbuild",
            "--target",
            "production",
            "-t",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/cloud-storage:$SHORT_SHA`,
            "./cloud-storage",
          ],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Push",
          args: [
            "push",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/cloud-storage:$SHORT_SHA`,
          ],
        },
        {
          name: "gcr.io/cloud-builders/kubectl",
          id: "Deploy to dev",
          args: [
            "set",
            "image",
            "deployment/cloud-storage-deployment",
            `cloud-storage=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/cloud-storage:$SHORT_SHA`,
            "--namespace",
            pulumi.interpolate`${namespace.id}`,
          ],
          envs: [
            pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
            `CLOUDSDK_COMPUTE_REGION=${location}`,
          ],
        },
      ],
      images: [
        `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/cloud-storage:$SHORT_SHA`,
      ],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
      substitutions: {
        _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
      },
    },
  }
);

const fileProcessorDeployment = new k8s.apps.v1.Deployment(
  `${envType}-file-processor-deployment`,
  {
    metadata: {
      labels: {
        app: "file-processor",
      },
      name: "file-processor-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "file-processor",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "file-processor",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/file-processor:09b2470`,
              name: "file-processor",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              env: secrets,
              resources: {
                requests: {
                  memory: "2Gi",
                  cpu: "0.5",
                },
              },
              // readinessProbe,
              // livenessProbe,
            },
          ],
        },
      },
    },
  }
);

const fileProcessorTrigger = new gcp.cloudbuild.Trigger(
  "file-processor-trigger",
  {
    location: location,
    github: {
      name: "ultrack",
      owner: "christopherstj",
      push: {
        branch: "^main$",
      },
    },
    includedFiles: ["file-processor/**/*"],
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
    build: {
      steps: [
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-login"],
          dir: "./file-processor",
        },
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-auth-npmrc"],
          dir: "./file-processor",
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Build",
          args: [
            "build",
            "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
            "--network=cloudbuild",
            "--target",
            "production",
            "-t",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/file-processor:$SHORT_SHA`,
            "./file-processor",
          ],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Push",
          args: [
            "push",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/file-processor:$SHORT_SHA`,
          ],
        },
        {
          name: "gcr.io/cloud-builders/kubectl",
          id: "Deploy to dev",
          args: [
            "set",
            "image",
            "deployment/file-processor-deployment",
            `file-processor=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/file-processor:$SHORT_SHA`,
            "--namespace",
            pulumi.interpolate`${namespace.id}`,
          ],
          envs: [
            pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
            `CLOUDSDK_COMPUTE_REGION=${location}`,
          ],
        },
      ],
      images: [
        `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/file-processor:$SHORT_SHA`,
      ],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
      substitutions: {
        _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
      },
    },
  }
);

const usersDeployment = new k8s.apps.v1.Deployment(
  `${envType}-users-deployment`,
  {
    metadata: {
      labels: {
        app: "users",
      },
      name: "users-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "users",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "users",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/users:41b968a`,
              name: "users",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
              env: secrets,
              // readinessProbe,
              // livenessProbe,
            },
            {
              image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.1.0",
              command: ["/cloud-sql-proxy"],
              args: [
                "--private-ip",
                "--structured-logs",
                "--port=3306",
                "animated-cell-381917:us-central1:ultrack-mysql-instance-86241db",
              ],
              name: "cloud-sql-proxy",
              securityContext: {
                runAsNonRoot: true,
              },
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
            },
          ],
        },
      },
    },
  }
);

const usersTrigger = new gcp.cloudbuild.Trigger("users-trigger", {
  location: location,
  github: {
    name: "ultrack",
    owner: "christopherstj",
    push: {
      branch: "^main$",
    },
  },
  includedFiles: ["users/**/*"],
  serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
  build: {
    steps: [
      {
        name: "gcr.io/cloud-builders/npm",
        args: ["run", "artifactregistry-login"],
        dir: "./users",
      },
      {
        name: "gcr.io/cloud-builders/npm",
        args: ["run", "artifactregistry-auth-npmrc"],
        dir: "./users",
      },
      {
        name: "gcr.io/cloud-builders/docker",
        id: "Build",
        args: [
          "build",
          "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
          "--network=cloudbuild",
          "--target",
          "production",
          "-t",
          `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/users:$SHORT_SHA`,
          "./users",
        ],
      },
      {
        name: "gcr.io/cloud-builders/docker",
        id: "Push",
        args: [
          "push",
          `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/users:$SHORT_SHA`,
        ],
      },
      {
        name: "gcr.io/cloud-builders/kubectl",
        id: "Deploy to dev",
        args: [
          "set",
          "image",
          "deployment/users-deployment",
          `users=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/users:$SHORT_SHA`,
          "--namespace",
          pulumi.interpolate`${namespace.id}`,
        ],
        envs: [
          pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
          `CLOUDSDK_COMPUTE_REGION=${location}`,
        ],
      },
    ],
    images: [
      `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/users:$SHORT_SHA`,
    ],
    options: {
      logging: "CLOUD_LOGGING_ONLY",
    },
    substitutions: {
      _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
    },
  },
});

const workoutsProcessorDeployment = new k8s.apps.v1.Deployment(
  `${envType}-workouts-processor-deployment`,
  {
    metadata: {
      labels: {
        app: "workouts-processor",
      },
      name: "workouts-processor-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "workouts-processor",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "workouts-processor",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/workouts-processor:a5d1976`,
              name: "workouts-processor",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              env: secrets,
              resources: {
                requests: {
                  memory: "2Gi",
                  cpu: "0.5",
                },
              },
              // readinessProbe,
              // livenessProbe,
            },
            {
              image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.1.0",
              command: ["/cloud-sql-proxy"],
              args: [
                "--private-ip",
                "--structured-logs",
                "--port=3306",
                "animated-cell-381917:us-central1:ultrack-mysql-instance-86241db",
              ],
              name: "cloud-sql-proxy",
              securityContext: {
                runAsNonRoot: true,
              },
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
            },
          ],
        },
      },
    },
  }
);

const workoutsProcessorTrigger = new gcp.cloudbuild.Trigger(
  "workouts-processor-trigger",
  {
    location: location,
    github: {
      name: "ultrack",
      owner: "christopherstj",
      push: {
        branch: "^main$",
      },
    },
    includedFiles: ["workouts-processor/**/*"],
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
    build: {
      steps: [
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-login"],
          dir: "./workouts-processor",
        },
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-auth-npmrc"],
          dir: "./workouts-processor",
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Build",
          args: [
            "build",
            "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
            "--network=cloudbuild",
            "--target",
            "production",
            "-t",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-processor:$SHORT_SHA`,
            "./workouts-processor",
          ],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Push",
          args: [
            "push",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-processor:$SHORT_SHA`,
          ],
        },
        {
          name: "gcr.io/cloud-builders/kubectl",
          id: "Deploy to dev",
          args: [
            "set",
            "image",
            "deployment/workouts-processor-deployment",
            `workouts-processor=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-processor:$SHORT_SHA`,
            "--namespace",
            pulumi.interpolate`${namespace.id}`,
          ],
          envs: [
            pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
            `CLOUDSDK_COMPUTE_REGION=${location}`,
          ],
        },
      ],
      images: [
        `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-processor:$SHORT_SHA`,
      ],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
      substitutions: {
        _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
      },
    },
  }
);

const workoutsRetrieverDeployment = new k8s.apps.v1.Deployment(
  `${envType}-workouts-retriever-deployment`,
  {
    metadata: {
      labels: {
        app: "workouts-retriever",
      },
      name: "workouts-retriever-deployment",
      namespace: namespace.id,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "workouts-retriever",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "workouts-retriever",
          },
          namespace: namespace.id,
        },
        spec: {
          serviceAccountName: `${envType}-service-account`,
          containers: [
            {
              image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/workouts-retriever:09b2470`,
              name: "workouts-retriever",
              ports: [
                {
                  containerPort: 80,
                },
              ],
              env: secrets,
              // readinessProbe,
              // livenessProbe,
              resources: {
                requests: {
                  memory: "0.5Gi",
                  cpu: "0.25",
                },
              },
            },
          ],
        },
      },
    },
  }
);

const workoutsRetrieverTrigger = new gcp.cloudbuild.Trigger(
  "workouts-retriever-trigger",
  {
    location: location,
    github: {
      name: "ultrack",
      owner: "christopherstj",
      push: {
        branch: "^main$",
      },
    },
    includedFiles: ["workouts-retriever/**/*"],
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/cicd-writer@animated-cell-381917.iam.gserviceaccount.com`,
    build: {
      steps: [
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-login"],
          dir: "./workouts-retriever",
        },
        {
          name: "gcr.io/cloud-builders/npm",
          args: ["run", "artifactregistry-auth-npmrc"],
          dir: "./workouts-retriever",
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Build",
          args: [
            "build",
            "--build-arg=GOOGLE_CREDS=$_GOOGLE_CREDS",
            "--network=cloudbuild",
            "--target",
            "production",
            "-t",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-retriever:$SHORT_SHA`,
            "./workouts-retriever",
          ],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          id: "Push",
          args: [
            "push",
            `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-retriever:$SHORT_SHA`,
          ],
        },
        {
          name: "gcr.io/cloud-builders/kubectl",
          id: "Deploy to dev",
          args: [
            "set",
            "image",
            "deployment/workouts-retriever-deployment",
            `workouts-retriever=${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-retriever:$SHORT_SHA`,
            "--namespace",
            pulumi.interpolate`${namespace.id}`,
          ],
          envs: [
            pulumi.interpolate`CLOUDSDK_CONTAINER_CLUSTER=${cluster.name}`,
            `CLOUDSDK_COMPUTE_REGION=${location}`,
          ],
        },
      ],
      images: [
        `${location}-docker.pkg.dev/$PROJECT_ID/docker-repo/workouts-retriever:$SHORT_SHA`,
      ],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
      substitutions: {
        _GOOGLE_CREDS: cfg.requireSecret("google-auth-creds"),
      },
    },
  }
);

// Exposure

const nodePort = new k8s.core.v1.Service(`${envType}-web-nodeport`, {
  metadata: {
    name: `${envType}-web-nodeport`,
    namespace: namespace.id,
  },
  spec: {
    selector: {
      app: "server",
    },
    type: "NodePort",
    ports: [
      {
        name: "http-port",
        port: 80,
        targetPort: 80,
      },
      {
        name: "https-port",
        port: 443,
        targetPort: 443,
      },
    ],
  },
});

// DNS

const zone = new gcp.dns.ManagedZone("ultrack-zone", {
  dnsName: "ultrack.app.",
});

const clusterRole = new k8s.rbac.v1.ClusterRole(`${envType}-dns-cluster-role`, {
  metadata: {
    name: `external-dns`,
    labels: {
      "app.kubernetes.io/name": "external-dns",
    },
  },
  rules: [
    {
      apiGroups: [""],
      resources: ["services", "endpoints", "pods", "nodes"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["extensions", "networking.k8s.io"],
      resources: ["ingresses"],
      verbs: ["get", "watch", "list"],
    },
  ],
});

const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
  `${envType}-dns-cluster-role-binding`,
  {
    metadata: {
      name: "external-dns-viewer",
      labels: {
        "app.kubernetes.io/name": "external-dns",
      },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "external-dns",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: `${envType}-service-account`,
        namespace: namespace.id,
      },
    ],
  }
);

// SSL Certificates

const managedCert = new k8s.yaml.ConfigFile("managed-cert", {
  file: "managed-cert.yaml",
});

const ingress = new k8s.networking.v1.Ingress(`${envType}-web-ingress`, {
  metadata: {
    name: `${envType}-web-ingress`,
    annotations: {
      "kubernetes.io/ingress.global-static-ip-name": "ultrack-ip",
      "networking.gke.io/managed-certificates": "managed-cert",
      "kubernetes.io/ingress.class": "gce",
    },
  },
  spec: {
    rules: [
      {
        host: "www.ultrack.app",
        http: {
          paths: [
            {
              path: "/*",
              pathType: "ImplementationSpecific",
              backend: {
                service: {
                  name: `${envType}-web-nodeport`,
                  port: {
                    number: 443,
                  },
                },
              },
            },
          ],
        },
      },
      {
        host: "ultrack.app",
        http: {
          paths: [
            {
              path: "/*",
              pathType: "ImplementationSpecific",
              backend: {
                service: {
                  name: `${envType}-web-nodeport`,
                  port: {
                    number: 443,
                  },
                },
              },
            },
          ],
        },
      },
    ],
  },
});

// Export the cluster's endpoint and credentials
export const clusterName = cluster.name;
export const clusterEndpoint = cluster.endpoint;
export const clusterMasterAuth = pulumi.secret(cluster.masterAuth);

// This only to be used when there's a new domain to add

// const dnsDeployment = new k8s.apps.v1.Deployment(`${envType}-dns-deployment`, {
//   metadata: {
//     name: "external-dns",
//     labels: {
//       "app.kubernetes.io/name": "external-dns",
//     },
//   },
//   spec: {
//     strategy: {
//       type: "Recreate",
//     },
//     selector: {
//       matchLabels: {
//         "app.kubernetes.io/name": "external-dns",
//       },
//     },
//     template: {
//       metadata: {
//         labels: {
//           "app.kubernetes.io/name": "external-dns",
//         },
//       },
//       spec: {
//         serviceAccountName: `${envType}-service-account`,
//         containers: [
//           {
//             name: "external-dns",
//             image: `${location}-docker.pkg.dev/animated-cell-381917/docker-repo/external-dns:v0.13.5`,
//             args: [
//               "--source=service",
//               "--source=ingress",
//               "--domain-filter=ultrack.app",
//               "--provider=google",
//               "--log-format=json",
//               "--google-zone-visibility=public",
//               "--policy=upsert-only",
//               "--registry=txt",
//               "--txt-owner-id=chris.r.stjean@gmail.com",
//             ],
//             resources: {
//               requests: {
//                 memory: "0.5Gi",
//                 cpu: "0.1",
//               },
//             },
//           },
//         ],
//       },
//     },
//   },
// });
