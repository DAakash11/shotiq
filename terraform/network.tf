# The network GKE runs on.
#
# GKE will happily create its own VPC if you let it. This does not, for one
# reason worth being able to defend: a cluster that made its own network
# owns it, and every address range in it was chosen by a default rather
# than by anyone. Declaring the network separately means the ranges are a
# decision on the record, and the cluster becomes a tenant of the network
# rather than its owner.

locals {
  # A local is a computed value, not an input. Variables are the knobs a
  # caller turns; locals are values derived once and reused, so a name
  # scheme lives in exactly one place instead of being retyped into
  # fifteen `name =` arguments where one can silently disagree.
  name_prefix = "shotiq"
}

# A VPC is a private, software-defined network spanning every GCP region.
# Unlike AWS, a GCP VPC is global -- subnets are regional, the network
# containing them is not.
resource "google_compute_network" "vpc" {
  name = "${local.name_prefix}-vpc"

  # The default is `true`, which creates a subnet in every GCP region --
  # 40-odd subnets with overlapping conventional ranges that nobody chose.
  # Turning it off means the only subnets that exist are the ones written
  # below. This is the first thing to change on any real VPC.
  auto_create_subnetworks = false

  # REGIONAL confines route advertisement to the region the subnet is in.
  # GLOBAL is for workloads spanning regions and costs more in
  # inter-region traffic. Everything here lives in one region.
  routing_mode = "REGIONAL"
}

# A SUBNET is a range of private IPs in one region. This one carries three
# separate ranges, which is the part that is specific to Kubernetes.
resource "google_compute_subnetwork" "gke" {
  name    = "${local.name_prefix}-gke-subnet"
  region  = var.region
  network = google_compute_network.vpc.id

  # --- primary range: the NODES ----------------------------------------
  #
  # One address per node VM. /24 is 256 addresses for a cluster that will
  # run two or three, which is deliberate slack rather than waste: the
  # primary range of a subnet CAN be expanded later, but shrinking it or
  # changing the others means replacing the subnet, and replacing a subnet
  # means replacing the cluster sitting on it.
  ip_cidr_range = "10.10.0.0/24"

  # --- secondary range: the PODS ---------------------------------------
  #
  # This is the piece with no equivalent outside Kubernetes, and the one
  # to understand.
  #
  # Every pod gets a real, routable IP from this range -- not a port
  # mapped on its host. That is "VPC-native" (alias IP) networking, and it
  # is why one pod can reach another by IP with no NAT in the middle, and
  # why a load balancer can send traffic straight to a pod instead of
  # bouncing off a node first.
  #
  # GKE hands each node a whole /24 out of this range at once, sized for
  # the default 110 pods per node. So the arithmetic is per NODE, not per
  # pod: a /20 is sixteen /24s, hence a ceiling of sixteen nodes. Ample
  # for a cluster capped at three, and small enough not to swallow the
  # private address space if this VPC ever gains a neighbour.
  #
  # Exhausting this range is a classic production incident: the cluster
  # refuses to add nodes, the error talks about IP exhaustion rather than
  # capacity, and the range cannot be resized in place.
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/20"
  }

  # --- secondary range: the SERVICES -----------------------------------
  #
  # ClusterIPs. These are virtual: no interface anywhere owns one, and
  # nothing ever ARPs for them. They exist only as iptables/eBPF rules on
  # every node that rewrite the destination to a real pod IP.
  #
  # Which is why this range is never routed and never overlaps anything
  # real -- and why "the service IP does not ping" is expected behaviour
  # rather than a fault.
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }

  # Lets nodes reach Google APIs -- Artifact Registry, Cloud Logging,
  # Cloud Monitoring -- over Google's internal network using their private
  # addresses, instead of hairpinning out to the public internet and back.
  # Faster, and it keeps image pulls off the billed egress path.
  private_ip_google_access = true
}
