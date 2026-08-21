# Inputs to this configuration.
#
# Declarations only. The values live in terraform.tfvars, which is
# gitignored -- so this file describes the SHAPE of an environment and
# says nothing about which one. That split is what makes the same config
# deployable twice.

variable "project_id" {
  description = "GCP project ID (not the display name -- the globally unique one)."
  type        = string

  # A validation block turns a wrong value into an error at plan time,
  # before a single API call. Without it, a display name typed here comes
  # back from GCP as a 403, which reads like a permissions problem and
  # sends you looking in entirely the wrong place.
  #
  # Project IDs are 6-30 characters, lowercase letters, digits and
  # hyphens, must start with a letter and cannot end with one.
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project ID: 6-30 chars, lowercase letters, digits and hyphens, starting with a letter. You may have used the project's display name by mistake."
  }
}

variable "region" {
  description = "GCP region for regional resources (the Artifact Registry repo, the VPC subnet)."
  type        = string

  # us-central1 is among the cheapest regions and is where GCP's free
  # tiers are most generous. The trade-off is latency: it is a long way
  # from South Asia, so the dashboard will feel slower than it does on
  # localhost. That is the right trade for a demo billed against trial
  # credit -- asia-south1 (Mumbai) would respond faster and cost roughly
  # 15-20% more per node-hour.
  default = "us-central1"
}

variable "zone" {
  description = "Zone for the GKE cluster's control plane and nodes."
  type        = string

  # A ZONE is one datacentre; a REGION is several zones close together.
  # The cluster is deliberately zonal rather than regional: a regional
  # cluster replicates the control plane across three zones and multiplies
  # the node count to match, which is correct for production and roughly
  # three times the cost of a demo that has no users to keep online.
  default = "us-central1-a"
}

# --- node pool sizing ---------------------------------------------------
#
# Every variable below exists because its default is expensive. Grouping
# them here means the cost of the cluster can be read off one screen
# rather than reconstructed from arguments scattered through cluster.tf.

variable "node_machine_type" {
  description = "Machine type for cluster nodes."
  type        = string

  # e2-medium is 2 shared vCPU and 4 GB. The obvious cheaper choice,
  # e2-small, has 2 GB -- of which only ~1.3 GB is ALLOCATABLE once GKE's
  # own system pods (kube-proxy, kube-dns, metrics-server, the logging
  # agent) have taken their reservation. The FastAPI container wants
  # 300-400 MB with pandas imported, so a 2 GB node spends its life
  # OOMKilled or leaving pods Pending.
  #
  # "Allocatable is not capacity" is the wall everyone hits once. It costs
  # about a cent an hour to stay off it.
  default = "e2-medium"
}

variable "node_disk_size_gb" {
  description = "Boot disk per node, in GB."
  type        = number

  # GKE's default is 100 GB. At roughly $0.10/GB/month that is $10 per
  # node per month of disk for an image set totalling about 1.5 GB -- and
  # it is billed whether or not the node is busy. 20 GB leaves ample room
  # for the OS, the kubelet and every ShotIQ image at once.
  #
  # This single line is the largest saving in the file.
  default = 20
}

variable "node_min_count" {
  description = "Floor for the autoscaler."
  type        = number

  # Two, not one. A single-node cluster cannot tolerate the node being
  # replaced -- and on Spot, being replaced is routine rather than
  # exceptional.
  default = 2
}

variable "node_max_count" {
  description = "Ceiling for the autoscaler. This is the cost cap."
  type        = number

  # The autoscaler will never exceed this, so this number multiplied by
  # the node hourly rate is the worst case the cluster can bill. Three.
  default = 3
}

variable "use_spot_nodes" {
  description = "Run nodes as Spot VMs (60-80% cheaper, reclaimable at 30 seconds' notice)."
  type        = bool

  # Spot instances are surplus capacity that Google can take back at any
  # time with a 30-second warning. For stateless replicas behind a
  # Deployment that is a rescheduling event, not an outage.
  #
  # Defaulting this to true is a deliberate exception to "a flag that
  # costs money should fail closed" -- here the SAFE default and the CHEAP
  # default are the same one, so the flag fails closed by being on.
  default = true
}
