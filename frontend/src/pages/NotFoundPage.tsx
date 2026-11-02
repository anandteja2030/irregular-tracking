import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/StateViews";
import { ArrowRightIcon } from "../components/icons";

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        eyebrow="Unmapped route"
        title="Nothing at this address"
        lede="The console only exposes the seven workspace surfaces. Use the rail or the command palette to return to a live view."
      />
      <EmptyState
        title="Surface not found"
        body="This path does not belong to any workspace in the console shell."
        actions={
          <Link className="btn" to="/">
            Return to Command Overview
            <span className="btn__icon">
              <ArrowRightIcon width={13} height={13} />
            </span>
          </Link>
        }
      />
    </>
  );
}
